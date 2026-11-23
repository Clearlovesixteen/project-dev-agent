import { prepareRequirementUpdate } from "./quality/requirement-update.js";
import { validateFeedbackUpdate } from "./feedback/task-update.js";
import {
  recordRequirementSources,
  referenceSources,
  stampRequirementSources,
  requirementReview,
  businessAssessmentReview,
  assertRequirementReview,
} from "./quality/requirement-review.js";
import { feedbackContext } from "./feedback/service.js";
import { feedbackReview, assertFeedback } from "./feedback/review.js";
import { captureWorkspaceBaseline } from "./git/workspace-baseline.js";
import {
  captureImplementationBaseline,
  requestReuseReview,
  assertRequestReuse,
} from "./quality/request-reuse.js";
import {
  recordImplementationBasis,
  implementationBasisReview,
  implementationAcceptanceToReopen,
  implementationReviewActions,
  assertImplementationBasis,
} from "./quality/implementation-basis.js";
import { recordValidationPlan } from "./quality/validation-plan.js";
import { recordBusinessPlan } from "./quality/business-plan.js";
import { assertBusinessPlan, businessPlanReview } from "./quality/business-plan-review.js";
import {
  validationReview,
  assertValidationReview,
} from "./quality/validation-review.js";
import {
  recordBusinessDeltas,
  businessDeltaReview,
  assertBusinessDeltas,
  applyBusinessDelta,
} from "./quality/business-deltas.js";
import { BusinessDeltaApplyInputSchema, enhancedBusinessDelta } from "./quality/business-delta-contracts.js";
import { assertEnhancedModelWrites } from "./runtime/business-model-release.js";
import { guidanceEnabled } from "./runtime/guidance-release.js";
import { VERSION } from "./version.js";
import { IdSchema } from "./domain/common.js";
import { validationRuns } from "./quality/validation-store.js";
import {
  qualityReview,
  projectEvaluation,
  assertBusinessAcceptance,
} from "./quality/review.js";
import { createHash, randomUUID } from "node:crypto";
import { assertTaskOwner, currentInteraction, interactionOwner } from "./workflow/interaction.js";
import { validateSpecification } from "./requirements/spec-input.js";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import { TaskSchema, type Task } from "./domain/task.js";
import { ToolResultSchema, type ToolResult } from "./domain/result.js";
import {
  assertBaseline,
  assertStateIgnored,
  bindWorktree,
  changedPaths,
  type WorktreeBinding,
} from "./git/index.js";
import { TaskStore } from "./storage/task-store.js";
import {
  TaskCheckInputSchema,
  TaskOpenInputSchema,
  TaskUpdateInputSchema,
} from "./tools/inputs.js";
import { ProjectFiles } from "./storage/project-files.js";
import { loadKnowledge, knowledgeSourceChecker } from "./knowledge/repository.js";
import { reviewSnapshot } from "./git/review-snapshot.js";
import { captureMergeRecovery, assertMergeResolved, assertMergeRecovery } from "./git/merge-recovery.js";
import { RequirementGroupStore } from "./coordination/requirement-groups.js";

/** 完整集合的回传不是全量复核；已有完成项只有被显式选中后才能刷新指纹。 */
function stampReviews<
  T extends { id: string; review_snapshot?: string | undefined },
>(
  incoming: T[] | undefined,
  previous: T[],
  complete: (entry: T) => boolean,
  token?: string,
  reviewedIds: string[] = [],
): T[] {
  const reviewed = new Set(reviewedIds);
  if (
    reviewedIds.some(
      (id) => !incoming?.some((entry) => entry.id === id && complete(entry)),
    )
  ) {
    throw new AppError(
      "REVIEW_ITEM_INVALID",
      "本次复核的 ID 必须属于同时提交的完整集合，且已填写完成状态和证据",
    );
  }
  if (reviewed.size && !token)
    throw new AppError(
      "REVIEW_SNAPSHOT_REQUIRED",
      "显式复核需要实际核验前取得的 review_snapshot",
    );
  if (!incoming) return previous;
  const content = ({ review_snapshot: _snapshot, ...entry }: T) => entry;
  return incoming.map((entry) => {
    const clean = content(entry);
    if (!complete(entry)) return clean as T;
    const prior = previous.find((old) => old.id === entry.id);
    if (prior && complete(prior) && !reviewed.has(entry.id)) {
      if (JSON.stringify(content(prior)) === JSON.stringify(clean))
        return prior;
      throw new AppError(
        "REVIEW_CONFIRMATION_REQUIRED",
        "修改已有完成项前请重新核验，并把该 ID 加入 reviewed_ids；仅修改说明或回传列表不能刷新旧证据",
      );
    }
    if (!token)
      throw new AppError(
        "REVIEW_SNAPSHOT_REQUIRED",
        "记录完成的审查或验证前，请用 task_check 获取 review_snapshot，在该版本上核验后将指纹传入 task_update",
      );
    return { ...clean, review_snapshot: token } as T;
  });
}

function staleReviews(task: Task, snapshot: string) {
  return {
    change_items: task.change_items
      .filter(
        (item) =>
          item.status !== "pending" && item.review_snapshot !== snapshot,
      )
      .map((item) => item.id),
    acceptance_criteria: task.acceptance_criteria
      .filter(
        (item) =>
          item.status === "checked" && item.review_snapshot !== snapshot,
      )
      .map((item) => item.id),
    validations: task.validations
      .filter(
        (item) =>
          item.outcome === "passed" && item.review_snapshot !== snapshot,
      )
      .map((item) => item.id),
  };
}

/** 需求组是协同索引，不能让侧车暂时不可写把已经落盘的核心任务伪装成失败。 */
function requirementGroupSyncDiagnostic(action: "register" | "update", error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "REQUIREMENT_GROUP_SYNC_PENDING",
    message: action === "register"
      ? `任务已经保存，但需求组登记暂未完成：${detail}。后续打开或更新任务时会继续尝试补登记。`
      : `任务状态已经保存，但需求组状态同步暂未完成：${detail}。后续更新任务时会继续尝试补同步。`,
  };
}

/** 维护任务生命周期，将 Git 实际改动与显式记录的验收和审查证据关联。 */
export class TaskService {
  private readonly store: TaskStore;
  private readonly groups: RequirementGroupStore;
  constructor(private readonly binding: WorktreeBinding) {
    this.store = new TaskStore(binding.root);
    this.groups = new RequirementGroupStore(binding.repo_identity);
  }

  /** 工作树任务是回放依据。登记中断后，重试打开或任一更新可恢复需求组索引。 */
  private async syncRequirementGroup(task: Task, action: "register" | "update") {
    if (!task.requirement_group_id) return { task, diagnostics: [] as { code: string; message: string }[] };
    try {
      const registration = await this.groups.register({ group_id: task.requirement_group_id, task_id: task.id, worktree_path: task.worktree_path,
        branch: task.baseline_branch, requirement_role: task.requirement_role ?? "full", scope_paths: task.scope_paths ?? [],
        relationship: task.requirement_group_relationship ?? "new_requirement", phase: task.phase });
      let synchronized = task;
      const diagnostics: { code: string; message: string }[] = [];
      if (task.phase === "active") {
        try {
          // 需求组登记锁内的最新结果必须回写本地任务。该操作只更新协同元数据，
          // 保留任务 owner、revision 及用户提交的所有记录，便于后续 task_check 恢复。
          synchronized = await this.store.syncCoordination(task.id, registration.scope_state, registration.related_task_ids);
        } catch (error) {
          diagnostics.push({ code: "TASK_COORDINATION_SYNC_PENDING", message: `任务已保存，但并发状态暂未写回：${error instanceof Error ? error.message : String(error)}。后续 task_check 或 task_update 会继续尝试。` });
        }
      }
      // resolve 可能早于另一个工作树的 register 完成；以锁内重算结果为准补发一次审查提示。
      // 任务已成功保存，提示只用于提醒集成前人工核对，不阻断当前开发。
      if (registration.scope_state === "scope_overlap_review" && task.parallel_state !== "scope_overlap_review") {
        diagnostics.push({
          code: "REQUIREMENT_SCOPE_OVERLAP_REVIEW",
          message: `需求组登记后发现相关工作树 ${registration.related_task_ids.join(", ")} 使用重叠范围；任务已建立，但集成前必须人工审查。`,
        });
      }
      if (action === "register" && task.phase === "active") {
        const cross = await this.groups.crossScopeOverlaps({ exclude_group_id: task.requirement_group_id, worktree_path: task.worktree_path, scope_paths: task.scope_paths ?? [] });
        if (cross.related_task_ids.length) diagnostics.push({
          code: "REQUIREMENT_CROSS_GROUP_SCOPE_OVERLAP_REVIEW",
          message: `其它需求组的工作树 ${cross.related_task_ids.join(", ")} 使用重叠范围；插件不会自动合并，集成前必须人工审查。`,
        });
      }
      return { task: synchronized, diagnostics };
    } catch (error) { return { task, diagnostics: [requirementGroupSyncDiagnostic(action, error)] }; }
  }

  /** CLI 与 MCP 共用错误约定，协议适配层无需识别存储或 Git 的具体异常。 */
  private async execute(
    action: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      return ToolResultSchema.parse(await action());
    } catch (error: unknown) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof z.ZodError
          ? "INVALID_INPUT"
          : "OPERATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "error", code, diagnostics: [{ code, message }],
        ...(error instanceof AppError && error.data ? { data: error.data } : {}) };
    }
  }

  /** 从当前工作区建立内容基线，保留接入前改动并单独跟踪本轮增量。 */
  async open(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskOpenInputSchema.parse(input);
      assertEnhancedModelWrites(!!request.business_model_policy);
      const current = await bindWorktree(this.binding.root);
      if (current.repo_identity !== this.binding.repo_identity)
        throw new AppError("REPOSITORY_CHANGED", "当前绑定的仓库标识已变化");
      await assertStateIgnored(current);
      const coordinationDiagnostics: { code: string; message: string }[] = [];
      try {
        const reconciled = await this.groups.reconcile();
        if (reconciled.archived_task_ids.length || reconciled.synchronized_task_ids.length || reconciled.unreadable_task_ids.length) {
          coordinationDiagnostics.push({
            code: "REQUIREMENT_GROUP_RECONCILED",
            message: `已核对需求组索引：归档 ${reconciled.archived_task_ids.length} 条、同步 ${reconciled.synchronized_task_ids.length} 条、待人工核对 ${reconciled.unreadable_task_ids.length} 条。`,
          });
        }
      } catch (error) {
        // 需求组是协同索引，不能因为清理暂时失败阻断核心任务创建；登记阶段会继续重试。
        coordinationDiagnostics.push({
          code: "REQUIREMENT_GROUP_RECONCILE_PENDING",
          message: `需求组索引暂未完成清理：${error instanceof Error ? error.message : String(error)}。后续打开或更新任务时会继续尝试。`,
        });
      }
      if (request.resolution_source && request.task_kind !== "merge_recovery")
        throw new AppError("MERGE_RECOVERY_INTENT_REQUIRED", "resolution_source 仅用于明确的 task_kind:merge_recovery 任务");
      const interaction = currentInteraction();
      // 先处理宿主重试幂等性，再进入需求组解析；否则同一操作重试会被
      // “当前工作树已有活跃任务”规则误判成并发新需求。
      const operationKey = interaction?.operation_id
        ? createHash("sha256")
            .update(
              JSON.stringify([
                interaction.session_id,
                interaction.actor_id ?? "main",
                interaction.operation_id,
              ]),
            )
            .digest("hex")
        : undefined;
      const operationFingerprint = interaction?.operation_id
        ? createHash("sha256").update(JSON.stringify(request)).digest("hex")
        : undefined;
      if (operationKey) {
        const existing = await this.store.findByOperationKey(operationKey);
        if (existing) {
          assertTaskOwner(existing);
          if (existing.operation_fingerprint !== operationFingerprint)
            throw new AppError("TASK_OPERATION_CONFLICT", "同一操作标识不能对应不同需求");
          // 已落盘的操作重试复用原基线，仍核对当前工作树、分支和可达性。
          await assertBaseline(current, existing);
          const sync = await this.syncRequirementGroup(existing, "register");
          return {
            outcome: "ok",
            code: "TASK_REUSED",
            data: sync.task,
            diagnostics: [...coordinationDiagnostics, ...sync.diagnostics],
          };
        }
      }
      const recovery = request.task_kind === "merge_recovery" ? await captureMergeRecovery(current, request.resolution_source) : undefined;
      if (recovery && request.scope_paths?.some(path => !recovery.conflicts.some(item => item.path === path)))
        throw new AppError("MERGE_RECOVERY_SCOPE", "恢复任务范围只能包含当前 merge 的原冲突文件，不接管其他改动");
      if (recovery && recovery.conflicts.length > 30) throw new AppError("MERGE_RECOVERY_LIMIT", "当前冲突超过30个文件，需先拆分并人工核对合并范围");
      const workspaceBaseline = await captureWorkspaceBaseline(current, recovery);
      const feedback = await feedbackContext(
        new ProjectFiles(current.root),
        request.requirement,
        request.scope_paths ?? [],
      );
      const references = referenceSources(request.requirement, request.requirement_sources ?? []);
      if (
        request.feedback_review &&
        (request.feedback_review.version !== feedback.version ||
          request.feedback_review.decisions.some(
            (decision) =>
              !feedback.items.some((item) => item.input.id === decision.id) ||
              decision.acceptance_ids.some(
                (id) =>
                  !request.acceptance_criteria.some((item) => item.id === id),
              ),
          ))
      )
        throw new AppError(
          "FEEDBACK_REVIEW_INVALID",
          "纠正版本、ID或关联验收不匹配，请重新查询当前范围",
        );
      const now = new Date().toISOString();
      const spec = request.spec_input ? validateSpecification(request.spec_input, ["task-request", ...(request.requirement_sources ?? []).map(source => source.id)]) : undefined;
      const taskId = randomUUID();
      const requirementSources = await recordRequirementSources(
        current,
        { requirement: request.requirement, corrections: [] },
        [],
        [
          { id: "task-request", kind: "request", quote: request.requirement },
          ...references,
        ],
      );
      if (request.spec_input && request.spec_input.kind !== "request") {
        const sourceIds = new Set(request.spec_input.source_ids);
        const hasDocumentSource = requirementSources.some(source => sourceIds.has(source.input.id) && source.input.kind === "document");
        if (!hasDocumentSource) coordinationDiagnostics.push({
          code: "SPECIFICATION_DOCUMENT_SOURCE_MISSING",
          message: `${request.spec_input.kind.toUpperCase()} 仅保存了输入类型和来源 ID，当前没有可用于跨工作树关联的文档指纹；请传入 kind=document 的 PRD/SDD 来源，或显式复用 requirement_group_id。`,
        });
      }
      // 所有普通任务都先走需求组解析。没有显式关联时由服务按唯一来源指纹
      // 自动关联，来源不唯一则创建新组或明确报歧义，不能依赖调用方是否传 role。
      const group = !recovery ? await this.groups.resolve({
        requirement: request.requirement,
        sources: requirementSources,
        acceptance: request.acceptance_criteria,
        worktree_path: current.root,
        branch: current.branch,
        scope_paths: request.scope_paths ?? [],
        ...(request.requirement_group_id ? { requested_group_id: request.requirement_group_id } : {}),
        ...(request.parent_task_id ? { parent_task_id: request.parent_task_id } : {}),
        ...(request.continuation_of_task_id ? { continuation_of_task_id: request.continuation_of_task_id } : {}),
      }) : undefined;
      const task = TaskSchema.parse({
        schema_version: 1,
        id: taskId,
        revision: 0,
        repo_identity: current.repo_identity,
        worktree_path: current.root,
        baseline_head: current.head,
        baseline_branch: current.branch,
        workspace_baseline: workspaceBaseline,
        phase: "active",
        requirement: request.requirement,
        ...(group ? { requirement_group_id: group.group_id, requirement_role: request.requirement_role ?? "full",
          requirement_group_relationship: group.relationship,
          requirement_fingerprint: group.requirement_fingerprint, parallel_state: group.scope_state,
          ...(request.parent_task_id ? { parent_task_id: request.parent_task_id } : {}),
          ...(request.continuation_of_task_id ? { continuation_of_task_id: request.continuation_of_task_id } : {}),
          ...(group.related_task_ids.length ? { related_task_ids: group.related_task_ids } : {}),
        } : {}),
        ...(spec ? { spec_input: spec } : {}),
        ...(interaction ? { owner: interactionOwner(interaction) } : {}),
        ...(operationKey ? { operation_key: operationKey } : {}),
        ...(operationFingerprint ? { operation_fingerprint: operationFingerprint } : {}),
        ...(request.evaluation ? { evaluation: request.evaluation } : {}),
        implementation_baseline: await captureImplementationBaseline(current),
        development_policy: 1,
        requirement_sources: requirementSources,
        ...(request.business_assessment
          ? { business_assessment: request.business_assessment }
          : {}),
        ...(request.business_model_policy ? { business_model_policy: request.business_model_policy } : {}),
        scope_paths: recovery ? recovery.conflicts.map(item => item.path) : request.scope_paths ?? [],
        feedback_policy: 1,
        ...(request.feedback_review
          ? { feedback_review: request.feedback_review }
          : !feedback.items.length
          ? { feedback_review: { version: feedback.version, decisions: [] } }
          : {}),
        implementation_policy: 1,
        validation_policy: 1,
        validation_plans: request.validation_plan
          ? [
              await recordValidationPlan(
                current,
                request.validation_plan,
                request.acceptance_criteria.map((item) => item.id),
              ),
            ]
          : [],
        implementation_bases: request.implementation_basis
          ? [
              await recordImplementationBasis(
                current,
                current.head,
                request.implementation_basis,
                request.acceptance_criteria.map((item) => item.id),
                workspaceBaseline,
              ),
            ]
          : [],
        acceptance_criteria: request.acceptance_criteria,
        change_items: recovery ? recovery.conflicts.map((item, index) => ({ id: `merge-${index + 1}`, target_path: item.path, action: "modify",
          requirement: request.requirement, rationale: recovery.source ? `按用户指定来源 ${recovery.source.reference} 解决当前合并冲突` : "核对原合并双方后，仅修复当前冲突文件",
          sources: [{ kind: "code", reference: item.path }] })) : [],
        created_at: now,
        updated_at: now,
      });
      let saved: Task;
      try {
        saved = await this.store.create(task);
      } catch (error) {
        // 先解析需求组再写本地任务时，互斥失败不能留下没有子任务的“幽灵组”。
        if (group?.link === "new") await this.groups.discardIfEmpty(group.group_id).catch(() => {});
        throw error;
      }
      const diagnostics = [...coordinationDiagnostics, ...(group?.scope_state === "scope_overlap_review"
        ? [{ code: "REQUIREMENT_SCOPE_OVERLAP_REVIEW", message: `同一需求组已有相关工作树 ${group.related_task_ids.join(", ")} 使用重叠范围；任务已建立，但集成前必须人工审查。` }]
        : group?.link === "auto_source_match"
        ? [{ code: "REQUIREMENT_GROUP_AUTO_LINKED", message: `已按唯一 PRD/SDD 来源指纹关联需求组 ${group.group_id}；如实际不是同一需求，请重新建立独立需求组。` }]
        : [])];
      const sync = await this.syncRequirementGroup(saved, "register");
      diagnostics.push(...sync.diagnostics);
      return {
        outcome: "ok",
        code: sync.task.id === task.id ? "TASK_OPENED" : "TASK_REUSED",
        data: sync.task,
        diagnostics,
      };
    });
  }

  /** 校验任务更新；实际落盘、版本递增和并发互斥由 TaskStore 负责。 */
  async update(input: unknown, includeClosureReceipt = false): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskUpdateInputSchema.parse(input);
      const prior = await this.store.load(request.task_id);
      assertTaskOwner(prior);
      // 基线失效仍允许显式中止并留下原因，但不能继续把普通更新或关闭记为有效。
      if (request.phase !== "aborted" && request.phase !== "suspended")
        await assertBaseline(this.binding, prior);
      const recovery = prior.workspace_baseline?.merge_recovery;
      if (recovery && request.phase !== "aborted" && request.phase !== "suspended") {
        if (request.change_items?.some(item => !recovery.conflicts.some(conflict => conflict.path === item.target_path)))
          throw new AppError("MERGE_RECOVERY_SCOPE", "恢复任务只能登记原冲突文件；额外业务修改必须另建任务");
        const state = await assertMergeRecovery(this.binding, recovery);
        if (state.conflicts.length && (request.review_snapshot || request.change_items?.some(item => item.status !== "pending")
          || request.acceptance_criteria?.some(item => item.status !== "pending") || request.validations?.some(item => item.outcome !== "not_run")))
          throw new AppError("UNMERGED_CHANGES", "未合并文件仍存在；可以准备恢复清单和依据，但不能登记已通过的审查或验证");
        if (request.phase === "closed") await assertMergeResolved(this.binding, recovery);
      }
      if (prior.phase === "suspended" || request.phase === "suspended") {
        if (Object.keys(request).some(key => !["task_id", "expected_revision", "phase", "suspend_reason", "abort_reason"].includes(key)))
          throw new AppError("TASK_LIFECYCLE_SEPARATE_REQUIRED", "挂起或恢复须单独保存，不同时改需求、依据和验收");
        if (prior.phase === "suspended" && request.phase !== "active" && request.phase !== "aborted")
          throw new AppError("TASK_RESUME_REQUIRED", "显式指定 phase:active 恢复，或 aborted 中止；原基线保持不变");
        const saved = await this.store.update(request.task_id, request.expected_revision, current => TaskSchema.parse({
          ...current, phase: request.phase,
          suspend_reason: request.phase === "suspended" ? request.suspend_reason : undefined,
          abort_reason: request.phase === "aborted" ? request.abort_reason : undefined,
          lifecycle: [...current.lifecycle ?? [], { phase: request.phase,
            reason: request.suspend_reason ?? request.abort_reason ?? `恢复挂起任务，原挂起原因：${current.suspend_reason}`,
            recorded_at: new Date().toISOString() }],
        }));
        const sync = await this.syncRequirementGroup(saved, "update");
        return { outcome: "ok", code: saved.phase === "suspended" ? "TASK_SUSPENDED" : saved.phase === "active" ? "TASK_RESUMED" : "TASK_UPDATED", data: sync.task, diagnostics: sync.diagnostics };
      }
      if (request.knowledge_versions?.length) {
        const files = new ProjectFiles(this.binding.root);
        const loaded = await loadKnowledge(files);
        const checkSources = knowledgeSourceChecker(files, loaded.config);
        for (const version of request.knowledge_versions) {
          // 已使用版本是历史依据，源码修改后仍保留；新引入的知识版本必须重新核验。
          if (
            prior.knowledge_versions.some(
              (entry) =>
                entry.id === version.id && entry.version === version.version,
            )
          )
            continue;
          const entry = loaded.entries.find(
            (entry) =>
              entry.knowledge.id === version.id &&
              entry.version === version.version,
          );
          if (!entry)
            throw new AppError(
              "KNOWLEDGE_VERSION_UNKNOWN",
              `请重新查询知识的当前版本：${version.id}`,
            );
          if (
            entry.knowledge.status !== "confirmed" ||
            (await checkSources(entry)).some(
              (source) => !["current", "attested"].includes(source.state),
            )
          ) {
            throw new AppError(
              "KNOWLEDGE_NEEDS_REVIEW",
              `该知识不是当前有效的确认规则：${version.id}`,
            );
          }
        }
      }
      if (request.phase === "closed") {
        // 关闭前核对完整 Git 改动，不能只检查调用方已经列出的文件。
        const expected = new Set(
          (request.change_items ?? prior.change_items).map(
            (item) => item.target_path,
          ),
        );
        const unexpected = (
          await reviewSnapshot(
            this.binding,
            prior.baseline_head,
            prior.workspace_baseline,
          )
        ).paths.filter((path) => !expected.has(path));
        if (unexpected.length > 0)
          throw new AppError(
            "UNREVIEWED_CHANGES",
            `关闭任务前请补充并审查清单之外的改动：${unexpected.join(", ")}`,
          );
      }
      // 先在任务文件锁外完成 Git、模型、验证和需求审查。提交阶段只做修订号
      // 与不可变字段核验，避免一个慢任务把同一工作树的恢复/读取全部阻塞。
      // 只从本次实际执行的关闭审查摘取结果，任务持久化及完整响应沿用原结构。
      let closureReceipt: Record<string, unknown> | undefined;
      const candidate = await (async (current) => {
          if (request.phase !== "aborted") assertEnhancedModelWrites(!!request.business_plan || !!current.business_model_policy
            || !!current.business_plans?.length || !!current.business_deltas?.some(delta => enhancedBusinessDelta(delta.input)));
          // 基于提交前读取的任务快照检查集合。最终提交仍通过修订号和追加约束
          // 防止并发更新抹去此前的验收或纠正记录。
          const collections = [
            "change_items",
            "acceptance_criteria",
            "validations",
            "corrections",
            "knowledge_versions",
          ] as const;
          for (const key of collections) {
            const replacement = request[key];
            if (
              replacement &&
              current[key].some(
                (entry) => !replacement.some((next) => next.id === entry.id),
              )
            ) {
              throw new AppError(
                "RECORD_REMOVAL_NOT_ALLOWED",
                `请保留已有 ${key} 记录，通过明确修订或处理来更新`,
              );
            }
          }
          const snapshot =
            request.phase === "aborted"
              ? undefined
              : await reviewSnapshot(
                  this.binding,
                  current.baseline_head,
                  current.workspace_baseline,
                  { allow_unmerged: request.phase !== "closed" && !!current.workspace_baseline?.merge_recovery },
                );
          if (
            request.review_snapshot &&
            request.review_snapshot !== snapshot?.hash
          )
            throw new AppError(
              "REVIEW_SNAPSHOT_CHANGED",
              "代码已不同于审查或验证时的快照，请重新读取 task_check 并执行受影响的检查",
            );
          const referenced =
            request.validations?.filter(
              (item) =>
                item.run_id &&
                JSON.stringify(item) !==
                  JSON.stringify(
                    current.validations.find((old) => old.id === item.id),
                  ),
            ) ?? [];
          if (referenced.length) {
            const records = await validationRuns(
              new ProjectFiles(this.binding.root),
              current.id,
            );
            for (const item of referenced) {
              const run = records.runs.find(
                (run) =>
                  run.id === item.run_id &&
                  run.repo_identity === this.binding.repo_identity &&
                  run.worktree_path === this.binding.root,
              );
              if (
                !run ||
                item.outcome === "not_run" ||
                (item.outcome === "passed" &&
                  (run.state !== "passed" ||
                    run.start_snapshot !== snapshot?.hash ||
                    run.end_snapshot !== snapshot.hash)) ||
                (item.outcome === "failed" && run.state === "passed")
              )
                throw new AppError(
                  "VALIDATION_RUN_INVALID",
                  "运行记录必须真实存在且与本项目、当前代码及所声明结果一致，不能伪造 run_id",
                );
            }
          }
          await validateFeedbackUpdate(this.binding, current, request);
          let bases = current.implementation_bases;
          let plans = current.validation_plans;
          let deltas = current.business_deltas;
          const requirementUpdate = await prepareRequirementUpdate(this.binding, current, request);
          if (request.business_deltas) {
            if (!snapshot || request.phase === "closed")
              throw new AppError(
                "BUSINESS_DELTA_REVIEW_REQUIRED",
                "先保存业务变化草案并完成验收，再发布模型与关闭任务",
              );
            deltas = await recordBusinessDeltas(
              this.binding,
              {
                ...current,
                ...requirementUpdate,
                corrections: request.corrections ?? current.corrections,
                acceptance_criteria:
                  request.acceptance_criteria ?? current.acceptance_criteria,
              },
              request.business_deltas,
            );
          }
          if (request.validation_plan) {
            if (!snapshot || request.phase === "closed")
              throw new AppError(
                "VALIDATION_PLAN_REVIEW_REQUIRED",
                "先保存检查计划并实际执行，不能在关闭时补计划",
              );
            if ((plans?.length ?? 0) >= 10)
              throw new AppError(
                "VALIDATION_PLAN_LIMIT",
                "本任务检查计划修订已达10版，请缩小任务范围",
              );
            const plan = await recordValidationPlan(
              this.binding,
              request.validation_plan,
              (request.acceptance_criteria ?? current.acceptance_criteria).map(
                (item) => item.id,
              ),
              plans?.at(-1),
            );
            if (plans?.at(-1)?.version !== plan.version)
              plans = [...(plans ?? []), plan];
          }
          const previousBasis = bases?.at(-1)?.basis;
          if (request.implementation_basis && JSON.stringify(request.implementation_basis) !== JSON.stringify(previousBasis)) {
            if (!snapshot || request.phase === "closed")
              throw new AppError(
                "IMPLEMENTATION_BASIS_REVIEW_REQUIRED",
                "先保存实现依据，再在当前代码上复核相关验收；不能在关闭时同时补写依据",
              );
            const acceptance =
              request.acceptance_criteria ?? current.acceptance_criteria;
            const reopen = implementationAcceptanceToReopen(previousBasis, request.implementation_basis);
            const blocking = acceptance.filter(item => reopen.has(item.id) && item.status !== "pending");
            if (blocking.length) {
              throw new AppError(
                "IMPLEMENTATION_BASIS_REVIEW_REQUIRED",
                `请在本次 task_update 将受影响的验收项重开为 pending，再保存依据并复核：${blocking.map(item => item.id).join("、")}`,
                { acceptance_ids: blocking.map(item => item.id) },
              );
            }
            if ((bases?.length ?? 0) >= 10)
              throw new AppError(
                "IMPLEMENTATION_BASIS_LIMIT",
                "本任务的依据修订已达10次，请完成当前任务或中止后缩小任务范围",
              );
            const record = await recordImplementationBasis(
              this.binding,
              current.baseline_head,
              request.implementation_basis,
              acceptance.map((item) => item.id),
              current.workspace_baseline,
              previousBasis,
            );
            if (record.review_snapshot !== snapshot.hash)
              throw new AppError(
                "REVIEW_SNAPSHOT_CHANGED",
                "建立实现依据期间代码发生变化，请重新核验",
              );
            bases = [...(bases ?? []), record];
          }
          let next = TaskSchema.parse({
            ...current,
            ...requirementUpdate,
            ...(request.feedback_review
              ? { feedback_review: request.feedback_review }
              : {}),
            ...(bases ? { implementation_bases: bases } : {}),
            ...(plans ? { validation_plans: plans } : {}),
            ...(deltas ? { business_deltas: deltas } : {}),
            change_items: stampReviews(
              request.change_items,
              current.change_items,
              (item) => item.status !== "pending",
              request.review_snapshot,
              request.reviewed_ids?.change_items,
            ),
            acceptance_criteria: stampReviews(
              request.acceptance_criteria,
              current.acceptance_criteria,
              (item) => item.status === "checked",
              request.review_snapshot,
              request.reviewed_ids?.acceptance_criteria,
            ),
            validations: stampReviews(
              request.validations,
              current.validations,
              (item) => item.outcome !== "not_run",
              request.review_snapshot,
              request.reviewed_ids?.validations,
            ),
            ...(request.corrections !== undefined
              ? { corrections: request.corrections }
              : {}),
            ...(request.knowledge_versions !== undefined
              ? { knowledge_versions: request.knowledge_versions }
              : {}),
            ...(request.phase !== undefined ? { phase: request.phase } : {}),
            ...(request.abort_reason !== undefined
              ? { abort_reason: request.abort_reason }
              : {}),
          });
          if (request.business_plan) {
            if (!snapshot || next.phase !== "active") throw new AppError("BUSINESS_PLAN_REQUIRED", "业务计划须在活跃任务中单独保存，不能在关闭时补写");
            const priorPlans = next.business_plans ?? [];
            if (priorPlans.length >= 6) throw new AppError("BUSINESS_PLAN_LIMIT", "本任务已保存六次业务计划，请缩小任务范围");
            const changedAcceptance = new Set([...request.business_plan.input_items.flatMap(item => item.acceptance_ids), ...request.business_plan.scenarios.map(item => item.acceptance_id)]);
            if (next.acceptance_criteria.some(item => changedAcceptance.has(item.id) && item.status !== "pending"))
              throw new AppError("BUSINESS_PLAN_ACCEPTANCE", "保存或修订业务计划前须重开相关验收，保存后再复核");
            const plan = await recordBusinessPlan(this.binding, next, request.business_plan, snapshot);
            next = TaskSchema.parse({ ...next, business_plans: [...priorPlans, plan] });
          }
          const actuallyReviewed = (request.acceptance_criteria ?? [])
            .filter(
              (item) =>
                item.status === "checked" &&
                (current.acceptance_criteria.find((old) => old.id === item.id)
                  ?.status !== "checked" ||
                  request.reviewed_ids?.acceptance_criteria.includes(item.id)),
            )
            .map((item) => item.id);
          next = TaskSchema.parse(
            await stampRequirementSources(this.binding, next, actuallyReviewed),
          );
          if (next.phase === "closed" && snapshot) {
            if (
              snapshot.paths.some(
                (path) =>
                  !next.change_items.some((item) => item.target_path === path),
              )
            )
              throw new AppError(
                "UNREVIEWED_CHANGES",
                "关闭前出现清单之外的改动，请补充审查",
              );
            if (
              Object.values(staleReviews(next, snapshot.hash)).some(
                (ids) => ids.length,
              )
            )
              throw new AppError(
                "REVIEW_STALE",
                "代码已变化或旧记录尚未绑定代码快照，请重新审查和验证后关闭任务",
              );
            assertImplementationBasis(
              await implementationBasisReview(
                this.binding,
                next,
                snapshot.hash,
              ),
            );
            assertBusinessDeltas(
              await businessDeltaReview(this.binding, next, snapshot.hash),
            );
            await assertRequestReuse(this.binding, next, snapshot.paths);
            try {
              await assertBusinessAcceptance(this.binding, next, snapshot.hash);
            } catch (error) {
              throw new AppError(
                "BUSINESS_CHECK_STALE",
                error instanceof Error ? error.message : String(error),
              );
            }
            const execution = await validationReview(this.binding, next, snapshot.hash, snapshot.paths);
            assertValidationReview(execution);
            const business = await businessPlanReview(this.binding, next, snapshot.hash, snapshot.paths, execution);
            assertBusinessPlan(business);
            await assertFeedback(this.binding, next, snapshot.hash);
            await assertRequirementReview(this.binding, next);
            if (includeClosureReceipt && guidanceEnabled()) closureReceipt = {
              version: VERSION, review_snapshot: snapshot.hash, repository: this.binding.repo_identity, worktree: this.binding.root,
              branch: this.binding.branch, validation_state: execution.state,
              plan_version: execution.plan_version, business_plan_state: business.state,
              checks: execution.checks.map(check => ({ id: check.id, state: check.state, run_id: check.run_id })),
            };
          }
          return next;
        })(prior);
      const saved = await this.store.updateCandidate(request.task_id, request.expected_revision, candidate);
      const sync = await this.syncRequirementGroup(saved, "update");
      return {
        outcome: "ok",
        code: "TASK_UPDATED",
        data: closureReceipt ? { ...sync.task, closure_receipt_v1: {
          ...closureReceipt, task_id: sync.task.id, revision: sync.task.revision,
        } } : sync.task,
        diagnostics: sync.diagnostics,
      };
    });
  }

  /** 固定按任务锁→模型锁发布；模型日志可恢复，任务保存失败时重试不会重复应用。 */
  async applyBusiness(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = BusinessDeltaApplyInputSchema.extend({
        task_id: IdSchema,
        expected_revision: z.number().int().nonnegative(),
      }).parse(input);
      const prior = await this.store.load(request.task_id);
      assertTaskOwner(prior);
      if (prior.revision !== request.expected_revision)
        throw new AppError("REVISION_CONFLICT", `预期修订号为 ${request.expected_revision}，实际为 ${prior.revision}`);
      // 业务模型与验证发布在任务锁外完成。任务记录只在最后以乐观修订号
      // 轻量递增，发布中断时由业务回执 journal 恢复，不让任务锁包住 Git/模型 IO。
      assertEnhancedModelWrites(!!prior.business_model_policy || !!prior.business_plans?.length);
      await assertBaseline(this.binding, prior);
      const snapshot = await reviewSnapshot(this.binding, prior.baseline_head, prior.workspace_baseline);
      const execution = await validationReview(this.binding, prior, snapshot.hash, snapshot.paths);
      assertValidationReview(execution);
      assertBusinessPlan(await businessPlanReview(this.binding, prior, snapshot.hash, snapshot.paths, execution));
      let receipt: unknown;
      const { task_id: _taskId, expected_revision: _revision, ...value } = request;
      receipt = await applyBusinessDelta(this.binding, prior, value);
      const saved = await this.store.updateCandidate(request.task_id, request.expected_revision, prior);
      return {
        outcome: "ok",
        code: "BUSINESS_DELTA_APPLIED",
        data: { task_id: saved.id, revision: saved.revision, receipt },
        diagnostics: [],
      };
    });
  }

  /** 只读核对任务与当前差异；返回完整记录，供新对话恢复或定位未完成项。 */
  async check(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskCheckInputSchema.parse(input);
      const task = request.task_id
        ? await this.store.load(request.task_id)
        : await this.store.active();
      if (!task)
        return {
          outcome: "ok",
          code: "NO_ACTIVE_TASK",
          data: { project: this.binding.root, active_task: null, ...(request.mode === "resume" ? { mode: "resume" } : {}) },
          diagnostics: [],
        };
      const task_id = task.id;
      if (!request.task_id || request.mode === "resume") assertTaskOwner(task);
      if (task.repo_identity !== this.binding.repo_identity)
        throw new AppError("TASK_BINDING_MISMATCH", "该任务属于其他仓库");
      // 续接只确认任务、归属与当前基线；冲突恢复任务允许仍存在已登记的冲突。
      // 此路径不签发快照、不改变已验收计数，终端验证和交付仍需完整审查。
      if (request.mode === "resume") {
        if (request.include_evaluation) throw new AppError("INVALID_INPUT", "项目评估应使用 review 模式");
        if (task.phase !== "active") return {
          outcome: "incomplete", code: "TASK_INACTIVE", data: { mode: "resume", task_id, revision: task.revision, phase: task.phase },
          diagnostics: [{ code: "TASK_INACTIVE", message: "此任务已结束或挂起，不能在本轮直接续接。" }],
        };
        await assertBaseline(this.binding, task);
        return { outcome: "ok", code: "TASK_CONTINUATION_READY", data: {
          mode: "resume", task_id, revision: task.revision, phase: task.phase, requirement: task.requirement,
          task_kind: task.workspace_baseline?.merge_recovery ? "merge_recovery" : "development",
          planned_paths: task.change_items.filter(item => item.action === "modify").map(item => item.target_path),
          quality_checked: false,
        }, diagnostics: [] };
      }
      if (task.phase !== "active") {
        return {
          outcome: "incomplete",
          code: "TASK_INACTIVE",
          data: {
            task_id,
            revision: task.revision,
            phase: task.phase,
            recorded_task: task,
            ...(request.include_evaluation
              ? { evaluation: await projectEvaluation(this.binding) }
              : {}),
          },
          diagnostics: [
            {
              code: "TASK_INACTIVE",
              message:
                "该任务已结束，其记录仅供历史查询；当前工作树的改动不会归入此任务。",
            },
          ],
        };
      }
      let changed: string[];
      let snapshot: string;
      try {
        await assertBaseline(this.binding, task);
        if (task.workspace_baseline?.merge_recovery) await assertMergeResolved(this.binding, task.workspace_baseline.merge_recovery);
        const current = await reviewSnapshot(
          this.binding,
          task.baseline_head,
          task.workspace_baseline,
        );
        changed = current.paths;
        snapshot = current.hash;
      } catch (error: unknown) {
        // 无法比较基线时仍返回原任务，便于恢复或中止；不得宣称检查通过。
        const code =
          error instanceof AppError ? error.code : "BASELINE_UNAVAILABLE";
        return {
          outcome: "incomplete",
          code,
          data: {
            task_id,
            revision: task.revision,
            phase: task.phase,
            recorded_task: task,
          },
          diagnostics: [
            {
              code,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
      const paths = new Set(changed);
      const pending = task.change_items
        .filter((item) => item.status === "pending")
        .map((item) => item.id);
      const acceptance = task.acceptance_criteria
        .filter((criterion) => criterion.status !== "checked")
        .map((criterion) => criterion.id);
      const validations = task.validations
        .filter((record) => record.outcome !== "passed")
        .map((record) => record.id);
      const expected = new Set(
        task.change_items.map((item) => item.target_path),
      );
      const unexpected = changed.filter((path) => !expected.has(path));
      const stale = staleReviews(task, snapshot),
        outdated = Object.values(stale).some((ids) => ids.length);
      // 同一快照上的独立只读检查分组执行，限制并发。业务计划必须使用真实验证结果。
      const [reuse, implementation, execution] = await Promise.all([
        requestReuseReview(this.binding, task, changed),
        implementationBasisReview(this.binding, task, snapshot),
        validationReview(this.binding, task, snapshot, changed),
      ]);
      const nextActions = implementationReviewActions(implementation);
      const [businessPlan, businessDelta, feedback] = await Promise.all([
        businessPlanReview(this.binding, task, snapshot, changed, execution),
        businessDeltaReview(this.binding, task, snapshot),
        feedbackReview(this.binding, task, snapshot),
      ]);
      // 这里只判断记录、复用保护和文件覆盖，不能独立判断业务语义。
      const basisReviewed =
        !implementation.required || implementation.state === "checked";
      const executionReviewed =
        !execution.required ||
        ["checked", "not_applicable"].includes(execution.state);
      const deltaReviewed = ["checked", "not_applicable"].includes(
        businessDelta.state,
      );
      const [requirements, business_assessment, quality] = await Promise.all([
        requirementReview(this.binding, task),
        businessAssessmentReview(this.binding, task),
        qualityReview(this.binding, task, changed, snapshot),
      ]);
      const reviewed =
        (!requirements.required || requirements.state === "checked") &&
        (!business_assessment.required ||
          business_assessment.state === "checked") &&
        (!feedback.required || feedback.state === "checked") &&
        deltaReviewed &&
        (!businessPlan.required || businessPlan.state === "checked") &&
        executionReviewed &&
        basisReviewed &&
        reuse.state === "checked" &&
        task.change_items.length > 0 &&
        pending.length === 0 &&
        acceptance.length === 0 &&
        validations.length === 0 &&
        unexpected.length === 0 &&
        !outdated;
      const reuseCode =
        reuse.state === "violations"
          ? "PROJECT_REUSE_REQUIRED"
          : reuse.state === "incomplete"
          ? "PROJECT_REUSE_CONTEXT_REQUIRED"
          : undefined;
      const basisCode = basisReviewed
        ? undefined
        : implementation.state === "missing"
        ? "IMPLEMENTATION_BASIS_REQUIRED"
        : "IMPLEMENTATION_BASIS_REVIEW_REQUIRED";
      const executionCode = executionReviewed
        ? undefined
        : execution.state === "missing"
        ? "VALIDATION_PLAN_REQUIRED"
        : "VALIDATION_RUN_REQUIRED";
      const deltaCode = deltaReviewed
        ? undefined
        : "BUSINESS_DELTA_REVIEW_REQUIRED";
      const businessPlanCode = businessPlan.required && businessPlan.state !== "checked"
        ? businessPlan.state === "missing" ? "BUSINESS_PLAN_REQUIRED"
          : "boundary" in businessPlan && businessPlan.boundary?.issues.length ? "BUSINESS_BOUNDARY_VIOLATION"
          : "issues" in businessPlan && businessPlan.issues?.length ? "BUSINESS_PLAN_INPUT_PENDING"
          : "BUSINESS_SCENARIO_REQUIRED"
        : undefined;
      const policyCode =
        feedback.required && feedback.state !== "checked"
          ? "FEEDBACK_REVIEW_REQUIRED"
          : requirements.required && requirements.state !== "checked"
          ? "REQUIREMENT_ACCEPTANCE_REQUIRED"
          : business_assessment.required &&
            business_assessment.state !== "checked"
          ? "BUSINESS_ASSESSMENT_REQUIRED"
          : undefined;
      const checkCode = reviewed
        ? "CHECKLIST_REVIEWED"
        : outdated
        ? "REVIEW_STALE"
        : basisCode === "IMPLEMENTATION_BASIS_REQUIRED"
        ? basisCode
        : reuseCode ??
          basisCode ??
          businessPlanCode ??
          executionCode ??
          deltaCode ??
          policyCode ??
          "REVIEW_INCOMPLETE";
      return {
        outcome: reviewed ? "ok" : "incomplete",
        code: checkCode,
        data: {
          task_id,
          revision: task.revision,
          phase: task.phase,
          baseline_head: task.baseline_head,
          ...(task.workspace_baseline?.merge_recovery ? { merge_recovery: {
            state: (await assertMergeRecovery(this.binding, task.workspace_baseline.merge_recovery)).completed ? "committed" : "resolved_uncommitted",
            limitation: "恢复检查只核对冲突解决与任务验收；未提交状态不代表已经提交或完成上线。",
          } } : {}),
          preexisting_paths:
            task.workspace_baseline?.entries.map((entry) => entry.path) ?? [],
          recorded_task: task,
          changed_paths: changed,
          unexpected_changes: unexpected,
          pending_items: pending,
          pending_acceptance: acceptance,
          unresolved_validations: validations,
          review_snapshot: snapshot,
          stale_evidence: stale,
          next_actions: nextActions,
          quality: {
            ...quality,
            reuse,
            implementation,
            execution,
            business_plan: businessPlan,
            business_delta: businessDelta,
            feedback,
            requirements,
            business_assessment,
          },
          ...(request.include_evaluation
            ? { evaluation: await projectEvaluation(this.binding) }
            : {}),
          items: task.change_items.map((item) => ({
            id: item.id,
            target_path: item.target_path,
            status: item.status,
            changed: paths.has(item.target_path),
          })),
          structurally_reviewed: reviewed,
          limitation:
            "代码指纹覆盖 Git 基线、当前有效改动和未跟踪文件；不包含被 Git 忽略的依赖和外部服务状态。记录新证据前需在此快照上实际核验。审查记录不能独立证明业务正确。",
        },
        diagnostics: reviewed
          ? []
          : [
              {
                code: checkCode,
                message:
                  executionCode === checkCode
                    ? "请核对 quality.execution：保存检查计划，用原终端运行 validation run，采用当前代码上的真实执行记录。"
                    : basisCode === checkCode
                    ? "请按 next_actions 核对具体实现依据和关联验收项。由 Agent 完成当前快照验证并提交实际证据。"
                    : reuseCode === checkCode
                    ? "请求层复用检查未通过：先核对 quality.reuse 中的既有入口、重复用法及覆盖范围，不能用表面完成的清单关闭任务。"
                    : businessPlanCode === checkCode
                    ? "请核对 quality.business_plan 中的原文、受保护位置和命名场景结果，处理未决问题后再验收。"
                    : policyCode === checkCode
                    ? "请核对 quality.feedback、quality.requirements 和 quality.business_assessment：更新纠正选择、来源版本或业务判断，保存后重新验收。"
                    : outdated
                    ? "代码变化或旧记录缺少指纹，部分证据需要重新核验。请在当前 review_snapshot 上完成检查，通过 reviewed_ids 明确本次复核的条目，并提交对应完整集合。"
                    : "部分改动、验收项或验证尚未完成审查，请检查任务清单和代码差异。",
              },
            ],
      };
    });
  }
}
