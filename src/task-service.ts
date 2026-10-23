import { captureImplementationBaseline, requestReuseReview, assertRequestReuse } from "./quality/request-reuse.js";
import { recordImplementationBasis, implementationBasisReview, assertImplementationBasis } from "./quality/implementation-basis.js";
import { recordValidationPlan } from "./quality/validation-plan.js";
import { validationReview, assertValidationReview } from "./quality/validation-review.js";
import { recordBusinessDeltas, businessDeltaReview, assertBusinessDeltas, applyBusinessDelta } from "./quality/business-deltas.js";
import { BusinessDeltaApplyInputSchema } from "./quality/business-delta-contracts.js";
import { IdSchema } from "./domain/common.js";
import { validationRuns } from "./quality/validation-store.js";
import { qualityReview, projectEvaluation, assertBusinessAcceptance } from "./quality/review.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import { TaskSchema, type Task } from "./domain/task.js";
import { ToolResultSchema, type ToolResult } from "./domain/result.js";
import { assertBaseline, assertClean, assertStateIgnored, bindWorktree, changedPaths, type WorktreeBinding } from "./git/index.js";
import { TaskStore } from "./storage/task-store.js";
import { TaskCheckInputSchema, TaskOpenInputSchema, TaskUpdateInputSchema } from "./tools/inputs.js";
import { ProjectFiles } from "./storage/project-files.js";
import { loadKnowledge, sourceStates } from "./knowledge/repository.js";
import { reviewSnapshot } from "./git/review-snapshot.js";

/** 完整集合的回传不是全量复核；已有完成项只有被显式选中后才能刷新指纹。 */
function stampReviews<T extends { id: string; review_snapshot?: string | undefined }>(incoming: T[] | undefined, previous: T[], complete: (entry: T) => boolean, token?: string, reviewedIds: string[] = []): T[] {
  const reviewed = new Set(reviewedIds);
  if (reviewedIds.some((id) => !incoming?.some((entry) => entry.id === id && complete(entry)))) {
    throw new AppError("REVIEW_ITEM_INVALID", "本次复核的 ID 必须属于同时提交的完整集合，且已填写完成状态和证据");
  }
  if (reviewed.size && !token) throw new AppError("REVIEW_SNAPSHOT_REQUIRED", "显式复核需要实际核验前取得的 review_snapshot");
  if (!incoming) return previous;
  const content = ({ review_snapshot: _snapshot, ...entry }: T) => entry;
  return incoming.map((entry) => {
    const clean = content(entry);
    if (!complete(entry)) return clean as T;
    const prior = previous.find((old) => old.id === entry.id);
    if (prior && complete(prior) && !reviewed.has(entry.id)) {
      if (JSON.stringify(content(prior)) === JSON.stringify(clean)) return prior;
      throw new AppError("REVIEW_CONFIRMATION_REQUIRED", "修改已有完成项前请重新核验，并把该 ID 加入 reviewed_ids；仅修改说明或回传列表不能刷新旧证据");
    }
    if (!token) throw new AppError("REVIEW_SNAPSHOT_REQUIRED", "记录完成的审查或验证前，请用 task_check 获取 review_snapshot，在该版本上核验后将指纹传入 task_update");
    return { ...clean, review_snapshot: token } as T;
  });
}

function staleReviews(task: Task, snapshot: string) {
  return {
    change_items: task.change_items.filter((item) => item.status !== "pending" && item.review_snapshot !== snapshot).map((item) => item.id),
    acceptance_criteria: task.acceptance_criteria.filter((item) => item.status === "checked" && item.review_snapshot !== snapshot).map((item) => item.id),
    validations: task.validations.filter((item) => item.outcome === "passed" && item.review_snapshot !== snapshot).map((item) => item.id),
  };
}

/** 维护任务生命周期，将 Git 实际改动与显式记录的验收和审查证据关联。 */
export class TaskService {
  private readonly store: TaskStore;
  constructor(private readonly binding: WorktreeBinding) {
    this.store = new TaskStore(binding.root);
  }

  /** CLI 与 MCP 共用错误约定，协议适配层无需识别存储或 Git 的具体异常。 */
  private async execute(action: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return ToolResultSchema.parse(await action());
    } catch (error: unknown) {
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "OPERATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "error", code, diagnostics: [{ code, message }] };
    }
  }

  /** 从干净工作树建立基线，避免把开发者已有改动误算到新任务中。 */
  async open(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskOpenInputSchema.parse(input);
      const current = await bindWorktree(this.binding.root);
      if (current.repo_identity !== this.binding.repo_identity) throw new AppError("REPOSITORY_CHANGED", "当前绑定的仓库标识已变化");
      await assertStateIgnored(current);
      await assertClean(current);
      const now = new Date().toISOString();
      const task = TaskSchema.parse({
        schema_version: 1, id: randomUUID(), revision: 0, repo_identity: current.repo_identity, worktree_path: current.root,
        baseline_head: current.head, baseline_branch: current.branch, phase: "active", requirement: request.requirement,
        ...(request.evaluation ? { evaluation: request.evaluation } : {}),
        implementation_baseline: await captureImplementationBaseline(current),
        implementation_policy: 1,
        validation_policy: 1,
        validation_plans: request.validation_plan ? [await recordValidationPlan(current, request.validation_plan, request.acceptance_criteria.map(item => item.id))] : [],
        implementation_bases: request.implementation_basis ? [await recordImplementationBasis(current, current.head, request.implementation_basis, request.acceptance_criteria.map(item => item.id))] : [],
        acceptance_criteria: request.acceptance_criteria, change_items: [], created_at: now, updated_at: now,
      });
      const saved = await this.store.create(task);
      return { outcome: "ok", code: "TASK_OPENED", data: saved, diagnostics: [] };
    });
  }

  /** 校验任务更新；实际落盘、版本递增和并发互斥由 TaskStore 负责。 */
  async update(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskUpdateInputSchema.parse(input);
      const prior = await this.store.load(request.task_id);
      // 基线失效仍允许显式中止并留下原因，但不能继续把普通更新或关闭记为有效。
      if (request.phase !== "aborted") await assertBaseline(this.binding, prior);
      if (request.knowledge_versions?.length) {
        const files = new ProjectFiles(this.binding.root);
        const loaded = await loadKnowledge(files);
        for (const version of request.knowledge_versions) {
          // 已使用版本是历史依据，源码修改后仍保留；新引入的知识版本必须重新核验。
          if (prior.knowledge_versions.some((entry) => entry.id === version.id && entry.version === version.version)) continue;
          const entry = loaded.entries.find((entry) => entry.knowledge.id === version.id && entry.version === version.version);
          if (!entry) throw new AppError("KNOWLEDGE_VERSION_UNKNOWN", `请重新查询知识的当前版本：${version.id}`);
          if (entry.knowledge.status !== "confirmed" || (await sourceStates(files, entry.knowledge)).some((source) => !["current", "attested"].includes(source.state))) {
            throw new AppError("KNOWLEDGE_NEEDS_REVIEW", `该知识不是当前有效的确认规则：${version.id}`);
          }
        }
      }
      if (request.phase === "closed") {
        // 关闭前核对完整 Git 改动，不能只检查调用方已经列出的文件。
        const expected = new Set((request.change_items ?? prior.change_items).map((item) => item.target_path));
        const unexpected = (await changedPaths(this.binding, prior.baseline_head)).filter((path) => !expected.has(path));
        if (unexpected.length > 0) throw new AppError("UNREVIEWED_CHANGES", `关闭任务前请补充并审查清单之外的改动：${unexpected.join(", ")}`);
      }
      const saved = await this.store.update(request.task_id, request.expected_revision, async (current) => {
        // 在存储锁内基于最新记录检查集合，防止替换时抹去此前的验收或纠正记录。
        const collections = ["change_items", "acceptance_criteria", "validations", "corrections", "knowledge_versions"] as const;
        for (const key of collections) {
          const replacement = request[key];
          if (replacement && current[key].some((entry) => !replacement.some((next) => next.id === entry.id))) {
            throw new AppError("RECORD_REMOVAL_NOT_ALLOWED", `请保留已有 ${key} 记录，通过明确修订或处理来更新`);
          }
        }
        const snapshot = request.phase === "aborted" ? undefined : await reviewSnapshot(this.binding, current.baseline_head);
        if (request.review_snapshot && request.review_snapshot !== snapshot?.hash) throw new AppError("REVIEW_SNAPSHOT_CHANGED", "代码已不同于审查或验证时的快照，请重新读取 task_check 并执行受影响的检查");
        const referenced = request.validations?.filter(item => item.run_id && JSON.stringify(item) !== JSON.stringify(current.validations.find(old => old.id === item.id))) ?? [];
        if (referenced.length) {
          const records = await validationRuns(new ProjectFiles(this.binding.root), current.id);
          for (const item of referenced) {
            const run = records.runs.find(run => run.id === item.run_id && run.repo_identity === this.binding.repo_identity && run.worktree_path === this.binding.root);
            if (!run || item.outcome === "not_run" || item.outcome === "passed" && (run.state !== "passed" || run.start_snapshot !== snapshot?.hash || run.end_snapshot !== snapshot.hash)
              || item.outcome === "failed" && run.state === "passed") throw new AppError("VALIDATION_RUN_INVALID", "运行记录必须真实存在且与本项目、当前代码及所声明结果一致，不能伪造 run_id");
          }
        }
        let bases = current.implementation_bases;
        let plans = current.validation_plans;
        let deltas = current.business_deltas;
        if (request.business_deltas) {
          if (!snapshot || request.phase === "closed") throw new AppError("BUSINESS_DELTA_REVIEW_REQUIRED", "先保存业务变化草案并完成验收，再发布模型与关闭任务");
          deltas = await recordBusinessDeltas(this.binding, { ...current, acceptance_criteria: request.acceptance_criteria ?? current.acceptance_criteria }, request.business_deltas);
        }
        if (request.validation_plan) {
          if (!snapshot || request.phase === "closed") throw new AppError("VALIDATION_PLAN_REVIEW_REQUIRED", "先保存检查计划并实际执行，不能在关闭时补计划");
          if ((plans?.length ?? 0) >= 10) throw new AppError("VALIDATION_PLAN_LIMIT", "本任务检查计划修订已达10版，请缩小任务范围");
          const plan = await recordValidationPlan(this.binding, request.validation_plan, (request.acceptance_criteria ?? current.acceptance_criteria).map(item => item.id), plans?.at(-1));
          if (plans?.at(-1)?.version !== plan.version) plans = [...plans ?? [], plan];
        }
        if (request.implementation_basis) {
          if (!snapshot || request.phase === "closed") throw new AppError("IMPLEMENTATION_BASIS_REVIEW_REQUIRED", "先保存实现依据，再在当前代码上复核相关验收；不能在关闭时同时补写依据");
          const acceptance = request.acceptance_criteria ?? current.acceptance_criteria;
          if (request.implementation_basis.decisions.some(decision => acceptance.some(item => item.id === decision.acceptance_id && item.status !== "pending"))) {
            throw new AppError("IMPLEMENTATION_BASIS_REVIEW_REQUIRED", "依据修订后须将相关验收项重开为 pending，保存后重新核验");
          }
          if ((bases?.length ?? 0) >= 10) throw new AppError("IMPLEMENTATION_BASIS_LIMIT", "本任务的依据修订已达10次，请完成当前任务或中止后缩小任务范围");
          const record = await recordImplementationBasis(this.binding, current.baseline_head, request.implementation_basis, acceptance.map(item => item.id));
          if (record.review_snapshot !== snapshot.hash) throw new AppError("REVIEW_SNAPSHOT_CHANGED", "建立实现依据期间代码发生变化，请重新核验");
          bases = [...bases ?? [], record];
        }
        const next = TaskSchema.parse({
          ...current,
          ...(bases ? { implementation_bases: bases } : {}),
          ...(plans ? { validation_plans: plans } : {}),
          ...(deltas ? { business_deltas: deltas } : {}),
          change_items: stampReviews(request.change_items, current.change_items, (item) => item.status !== "pending", request.review_snapshot, request.reviewed_ids?.change_items),
          acceptance_criteria: stampReviews(request.acceptance_criteria, current.acceptance_criteria, (item) => item.status === "checked", request.review_snapshot, request.reviewed_ids?.acceptance_criteria),
          validations: stampReviews(request.validations, current.validations, (item) => item.outcome !== "not_run", request.review_snapshot, request.reviewed_ids?.validations),
          ...(request.corrections !== undefined ? { corrections: request.corrections } : {}),
          ...(request.knowledge_versions !== undefined ? { knowledge_versions: request.knowledge_versions } : {}),
          ...(request.phase !== undefined ? { phase: request.phase } : {}),
          ...(request.abort_reason !== undefined ? { abort_reason: request.abort_reason } : {}),
        });
        if (next.phase === "closed" && snapshot) {
          if (snapshot.paths.some((path) => !next.change_items.some((item) => item.target_path === path))) throw new AppError("UNREVIEWED_CHANGES", "关闭前出现清单之外的改动，请补充审查");
          if (Object.values(staleReviews(next, snapshot.hash)).some((ids) => ids.length)) throw new AppError("REVIEW_STALE", "代码已变化或旧记录尚未绑定代码快照，请重新审查和验证后关闭任务");
          assertImplementationBasis(await implementationBasisReview(this.binding, next, snapshot.hash));
          assertBusinessDeltas(await businessDeltaReview(this.binding, next, snapshot.hash));
          await assertRequestReuse(this.binding, next, snapshot.paths);
          try { await assertBusinessAcceptance(this.binding, next, snapshot.hash); }
          catch (error) { throw new AppError("BUSINESS_CHECK_STALE", error instanceof Error ? error.message : String(error)); }
          assertValidationReview(await validationReview(this.binding, next, snapshot.hash, snapshot.paths));
        }
        return next;
      });
      return { outcome: "ok", code: "TASK_UPDATED", data: saved, diagnostics: [] };
    });
  }

  /** 固定按任务锁→模型锁发布；模型日志可恢复，任务保存失败时重试不会重复应用。 */
  async applyBusiness(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = BusinessDeltaApplyInputSchema.extend({ task_id: IdSchema, expected_revision: z.number().int().nonnegative() }).parse(input);
      let receipt: unknown;
      const saved = await this.store.update(request.task_id, request.expected_revision, async current => {
        await assertBaseline(this.binding, current);
        const snapshot = await reviewSnapshot(this.binding, current.baseline_head);
        assertValidationReview(await validationReview(this.binding, current, snapshot.hash, snapshot.paths));
        const { task_id: _taskId, expected_revision: _revision, ...value } = request;
        receipt = await applyBusinessDelta(this.binding, current, value);
        return current;
      });
      return { outcome: "ok", code: "BUSINESS_DELTA_APPLIED", data: { task_id: saved.id, revision: saved.revision, receipt }, diagnostics: [] };
    });
  }

  /** 只读核对任务与当前差异；返回完整记录，供新对话恢复或定位未完成项。 */
  async check(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskCheckInputSchema.parse(input);
      const task = request.task_id ? await this.store.load(request.task_id) : await this.store.active();
      if (!task) return { outcome: "ok", code: "NO_ACTIVE_TASK", data: { project: this.binding.root, active_task: null }, diagnostics: [] };
      const task_id = task.id;
      if (task.repo_identity !== this.binding.repo_identity) throw new AppError("TASK_BINDING_MISMATCH", "该任务属于其他仓库");
      if (task.phase !== "active") {
        return { outcome: "incomplete", code: "TASK_INACTIVE", data: { task_id, revision: task.revision, phase: task.phase, recorded_task: task, ...(request.include_evaluation ? { evaluation: await projectEvaluation(this.binding) } : {}) },
          diagnostics: [{ code: "TASK_INACTIVE", message: "该任务已结束，其记录仅供历史查询；当前工作树的改动不会归入此任务。" }] };
      }
      let changed: string[];
      let snapshot: string;
      try {
        await assertBaseline(this.binding, task);
        const current = await reviewSnapshot(this.binding, task.baseline_head);
        changed = current.paths; snapshot = current.hash;
      } catch (error: unknown) {
        // 无法比较基线时仍返回原任务，便于恢复或中止；不得宣称检查通过。
        const code = error instanceof AppError ? error.code : "BASELINE_UNAVAILABLE";
        return { outcome: "incomplete", code, data: { task_id, revision: task.revision, phase: task.phase, recorded_task: task },
          diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] };
      }
      const paths = new Set(changed);
      const pending = task.change_items.filter((item) => item.status === "pending").map((item) => item.id);
      const acceptance = task.acceptance_criteria.filter((criterion) => criterion.status !== "checked").map((criterion) => criterion.id);
      const validations = task.validations.filter((record) => record.outcome !== "passed").map((record) => record.id);
      const expected = new Set(task.change_items.map((item) => item.target_path));
      const unexpected = changed.filter((path) => !expected.has(path));
      const stale = staleReviews(task, snapshot), outdated = Object.values(stale).some((ids) => ids.length);
      const reuse = await requestReuseReview(this.binding, task, changed);
      const implementation = await implementationBasisReview(this.binding, task, snapshot);
      const execution = await validationReview(this.binding, task, snapshot, changed);
      const businessDelta = await businessDeltaReview(this.binding, task, snapshot);
      // 这里只判断记录、复用保护和文件覆盖，不能独立判断业务语义。
      const basisReviewed = !implementation.required || implementation.state === "checked";
      const executionReviewed = !execution.required || ["checked", "not_applicable"].includes(execution.state);
      const deltaReviewed = ["checked", "not_applicable"].includes(businessDelta.state);
      const reviewed = deltaReviewed && executionReviewed && basisReviewed && reuse.state === "checked" && task.change_items.length > 0 && pending.length === 0 && acceptance.length === 0 && validations.length === 0 && unexpected.length === 0 && !outdated;
      const reuseCode = reuse.state === "violations" ? "PROJECT_REUSE_REQUIRED" : reuse.state === "incomplete" ? "PROJECT_REUSE_CONTEXT_REQUIRED" : undefined;
      const basisCode = basisReviewed ? undefined : implementation.state === "missing" ? "IMPLEMENTATION_BASIS_REQUIRED" : "IMPLEMENTATION_BASIS_REVIEW_REQUIRED";
      const executionCode = executionReviewed ? undefined : execution.state === "missing" ? "VALIDATION_PLAN_REQUIRED" : "VALIDATION_RUN_REQUIRED";
      const deltaCode = deltaReviewed ? undefined : "BUSINESS_DELTA_REVIEW_REQUIRED";
      const checkCode = reviewed ? "CHECKLIST_REVIEWED" : outdated ? "REVIEW_STALE" : basisCode === "IMPLEMENTATION_BASIS_REQUIRED" ? basisCode : reuseCode ?? basisCode ?? executionCode ?? deltaCode ?? "REVIEW_INCOMPLETE";
      return {
        outcome: reviewed ? "ok" : "incomplete", code: checkCode,
        data: {
          task_id, revision: task.revision, phase: task.phase, baseline_head: task.baseline_head,
          recorded_task: task,
          changed_paths: changed, unexpected_changes: unexpected, pending_items: pending,
          pending_acceptance: acceptance, unresolved_validations: validations,
          review_snapshot: snapshot, stale_evidence: stale,
          quality: { ...await qualityReview(this.binding, task, changed, snapshot), reuse, implementation, execution, business_delta: businessDelta },
          ...(request.include_evaluation ? { evaluation: await projectEvaluation(this.binding) } : {}),
          items: task.change_items.map((item) => ({ id: item.id, target_path: item.target_path, status: item.status, changed: paths.has(item.target_path) })),
          structurally_reviewed: reviewed,
          limitation: "代码指纹覆盖 Git 基线、当前有效改动和未跟踪文件；不包含被 Git 忽略的依赖和外部服务状态。记录新证据前需在此快照上实际核验。审查记录不能独立证明业务正确。",
        },
        diagnostics: reviewed ? [] : [{ code: checkCode, message: executionCode === checkCode ? "请核对 quality.execution：保存检查计划，用原终端运行 validation run，采用当前代码上的真实执行记录。" : basisCode === checkCode ? "请核对 quality.implementation：先建立项目实现依据，再逐项复核所关联的验收。依据与实现选择由 Agent 维护，无需用户额外填写。" : reuseCode === checkCode ? "请求层复用检查未通过：先核对 quality.reuse 中的既有入口、重复用法及覆盖范围，不能用表面完成的清单关闭任务。" : outdated
          ? "代码变化或旧记录缺少指纹，部分证据需要重新核验。请在当前 review_snapshot 上完成检查，通过 reviewed_ids 明确本次复核的条目，并提交对应完整集合。"
          : "部分改动、验收项或验证尚未完成审查，请检查任务清单和代码差异。" }],
      };
    });
  }
}
