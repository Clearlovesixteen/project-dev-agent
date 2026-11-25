import { createHash } from "node:crypto";
import { loadConfig, type ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import { ruleReviews, type RuleReviews } from "./rule-reviews.js";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/baseline.js";
import { ProjectKnowledgeRepository } from "./repository.js";
import { collectSourceStamp, isConfigurationPath, type SourceStamp } from "./source-stamp.js";
import { ModuleSnapshotSchema, resolveKnowledgeView, type KnowledgeView, type ModuleSnapshot } from "./view-resolver.js";
import { ObjectEnvelopeSchema, ProjectKnowledgeApplyReceiptSchema, type ObjectEnvelope, type ProjectIdentity, type SnapshotPointer, type ProjectKnowledgeApplyReceipt } from "./contracts.js";
import { ModelVerificationInputSchema, isVerifiedTrust, modelTrust, type ModelTrust, type ModelVerificationInput } from "./model-trust.js";
import { TaskStore } from "../storage/task-store.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { worktreeModel } from "./model-visibility.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * 快照的源码证据指纹只关注内容、路径和配置，不把 staged/unstaged 这种
 * 同内容的 Git 状态变化当成新的业务语义。SourceStamp 本身仍保留完整状态，
 * 供当前视图和诊断使用；这里避免同一模型因单纯 git add 产生两个同证据候选。
 */
function evidenceStampId(source: SourceStamp): string {
  return digest(JSON.stringify({
    head: source.head,
    entries: source.entries.map(({ path, kind, sha256, bytes, target, error }) => ({ path, kind, sha256, bytes, ...(target ? { target } : {}), ...(error ? { error } : {}) })),
    configuration: source.configuration,
    coverage: source.coverage,
  }));
}

export interface ProjectKnowledgeStatus {
  state: "not_initialized" | "empty" | "unverified" | "matched" | "needs_review" | "partial" | "unavailable";
  project_id?: string;
  transaction_id?: string;
  snapshot_count: number;
  source_stamp_id?: string;
  view_token?: string;
  modules?: KnowledgeView["modules"];
  /** 当前源码确实匹配的共享模型正文；歧义/过期时不返回，避免 Codex 误用旧分支结论。 */
  selected_models?: Array<{ snapshot_id: string; model_id: string; module: string; basis: ModuleSnapshot["basis"]; content: unknown; trust: ModelTrust; provenance?: ModuleSnapshot["provenance"] }>;
  rule_reviews?: RuleReviews;
  unresolved?: string[];
  coverage?: SourceStamp["coverage"];
  message?: string;
}

/** 钩子用的轻量状态探测：只读 identity/CURRENT，不扫描工作树；完整适用性由 project_context 核验。 */
export async function readProjectKnowledgeLight(binding: WorktreeBinding): Promise<ProjectKnowledgeStatus> {
  try {
    const repository = await ProjectKnowledgeRepository.openExisting(binding.repo_identity);
    if (!repository) return { state: "not_initialized", snapshot_count: 0 };
    const identity = await repository.files.readIdentity(), pointer = await repository.current();
    if (!identity) throw new AppError("PROJECT_KNOWLEDGE_IDENTITY_MISSING", "项目知识库缺少身份记录");
    if (!pointer) return { state: "empty", project_id: identity.project_id, snapshot_count: 0 };
    // CURRENT 只记录本次事务的对象。优先读取同事务的物化索引，避免轻量钩子
    // 把“本次提交对象数”误报成“当前项目全部快照数”；索引缺失时保留兼容回退。
    const index = await repository.files.readCurrentObjectIndex();
    const snapshot_count = index?.transaction_id === pointer.transaction_id ? index.object_ids.length : pointer.object_ids.length;
    return { state: "unverified", project_id: identity.project_id, transaction_id: pointer.transaction_id,
      snapshot_count, message: "钩子仅读取共享事务状态；编码前由 project_context 核验当前源码适用性" };
  } catch (error) {
    return { state: "unavailable", snapshot_count: 0, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 读取项目共享知识的当前视图；普通查询只读，不会创建项目库或改写快照。 */
export async function readProjectKnowledge(binding: WorktreeBinding, options: { reviewedSnapshots?: Map<string, ModuleSnapshot>; applyReceipts?: ProjectKnowledgeApplyReceipt[]; focusRules?: Set<string>; evidence?: { stamp?: SourceStamp; config?: ProjectConfig } } = {}): Promise<ProjectKnowledgeStatus> {
  let repository: ProjectKnowledgeRepository | undefined;
  let identity: ProjectIdentity | undefined;
  let pointer: SnapshotPointer | undefined;
  try {
    repository = await ProjectKnowledgeRepository.openExisting(binding.repo_identity);
    if (!repository) return { state: "not_initialized", snapshot_count: 0 };
    const opened = repository;
    identity = await opened.files.readIdentity();
    pointer = await opened.current();
    if (!identity) throw new AppError("PROJECT_KNOWLEDGE_IDENTITY_MISSING", "项目知识库缺少身份记录");
    if (!pointer) return { state: "empty", project_id: identity.project_id, snapshot_count: 0 };
    const objectIds = await opened.currentObjectIds(pointer);
    const objects = await Promise.all(objectIds.map((id) => opened.readObject(id)));
    // 验收时同时取得这一次 CURRENT 中的回执，避免复核模型和回执读取不同事务。
    if (options.applyReceipts) for (const object of objects) {
      if (object.object_type !== "receipt") continue;
      const receipt = ProjectKnowledgeApplyReceiptSchema.safeParse(object.content);
      if (receipt.success) options.applyReceipts.push(receipt.data);
    }
    const snapshots = options.reviewedSnapshots ?? new Map<string, ModuleSnapshot>();
    const paths = objects.flatMap(object => {
      if (object.object_type !== "module_snapshot") return [];
      const snapshot = ModuleSnapshotSchema.parse(object.content);
      snapshots.set(object.object_id, snapshot);
      return [...snapshot.source_fingerprints, ...snapshot.dependency_fingerprints, ...snapshot.configuration_fingerprints].map(item => item.path);
    });
    const source_stamp = await collectSourceStamp(binding, { paths, includeConfiguration: true });
    const view = resolveKnowledgeView({ source_stamp, snapshots: objects });
    const state = view.modules.length === 0 ? "empty" : view.modules.some((item) => item.state === "partial") ? "partial" : view.unresolved.length ? "needs_review" : "matched";
    // 覆盖不足时保留快照 ID 给排障工具，业务查询只接收已经完整核验的正文。
    const matchedIds = view.modules.flatMap(item => item.state === "matched" && item.selected_snapshot_id ? [item.selected_snapshot_id] : []);
    const selected_models = matchedIds.map((id) => {
      const object = objects.find((item) => item.object_id === id);
      if (!object || object.object_type !== "module_snapshot") return undefined;
      const snapshot = snapshots.get(id)!;
      return { snapshot_id: id, model_id: snapshot.model_id, module: snapshot.module, basis: snapshot.basis, content: snapshot.content,
        trust: modelTrust(snapshot.trust), ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}) };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const config = view.modules.length ? (await loadConfig(new ProjectFiles(binding.root))).config : undefined;
    // 写前核对使用同一次查询取得的完整指纹，展示给会话的复核原因可以截断。
    if (config && options.evidence) Object.assign(options.evidence, { stamp: source_stamp, config });
    const reviews = config ? ruleReviews(snapshots, view.modules, source_stamp, config, options.focusRules) : undefined;
    return { state, ...(reviews?.items.length ? { rule_reviews: reviews } : {}), project_id: identity.project_id, transaction_id: pointer.transaction_id, snapshot_count: objectIds.length,
      source_stamp_id: source_stamp.stamp_id, view_token: view.view_token, modules: view.modules, selected_models, unresolved: view.unresolved, coverage: source_stamp.coverage };
  } catch (error) {
    const common = { ...(identity?.project_id ? { project_id: identity.project_id } : {}), ...(pointer?.transaction_id ? { transaction_id: pointer.transaction_id } : {}), snapshot_count: pointer?.object_ids.length ?? 0 };
    if (error instanceof AppError && error.code === "VIEW_CHANGED") return {
      state: "needs_review", ...common, message: "读取期间工作树发生变化，请在下一次查询重新核验",
    };
    return { state: "unavailable", ...common, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 只允许读取当前项目事务链中的指定候选，供人工核对歧义快照。 */
export async function readModelSnapshot(binding: WorktreeBinding, modelId: string, snapshotId: string): Promise<ModuleSnapshot> {
  const repository = await ProjectKnowledgeRepository.openExisting(binding.repo_identity);
  if (!repository || !(await repository.currentObjectIds()).includes(snapshotId))
    throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "此快照不在当前项目知识库中");
  const object = await repository.readObject(snapshotId);
  const parsed = object.object_type === "module_snapshot" ? ModuleSnapshotSchema.safeParse(object.content) : undefined;
  if (!parsed?.success || parsed.data.model_id !== modelId)
    throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "此快照不属于指定业务模型");
  return parsed.data;
}

/** 将当前工作树的已保存模型以不可变快照写入项目库；失败不回滚本地模型。 */
export interface ModelShadowReceiptInput {
  operation_id: string;
  task_id: string;
  delta_id: string;
  delta_fingerprint: string;
  review_snapshot: string;
}

/**
 * 将本地模型作为项目级不可变快照提交。
 *
 * 业务变更应用时可同时传入 receipt：快照和回执会进入同一项目知识事务，
 * 这样工作树本地记录已落盘而共享库未更新时，下一次可按 operation_id 完整
 * 重试；不会出现只留下“模型已改”却找不到任务来源的半条记录。
 */
export async function publishModelShadow(
  binding: WorktreeBinding,
  model: Record<string, unknown>,
  options: { receipt?: ModelShadowReceiptInput; parent_snapshot_ids?: string[]; expected_transaction_id?: string | null; base_model?: Record<string, unknown> } = {},
): Promise<{ snapshot_id: string; receipt_id?: string; source_stamp_id: string }> {
  const repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const modelId = typeof model.id === "string" ? model.id : "unknown";
  const revision = typeof model.revision === "number" ? model.revision : 0;
  const basis = (() => {
    const rules = Array.isArray(model.rules) ? model.rules : [];
    if (rules.some((rule) => typeof rule === "object" && rule !== null && (rule as Record<string, unknown>).basis === "observed")) return "observed";
    if (rules.some((rule) => typeof rule === "object" && rule !== null && (rule as Record<string, unknown>).basis === "intended")) return "intended";
    return "inferred";
  })() as "observed" | "intended" | "inferred";
  const related = Array.isArray(model.related_versions) ? model.related_versions.filter((item): item is { path: string; sha256: string } => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).sha256 === "string") : [];
  // 本地 SavedModel 带有工作树绝对路径，跨工作树共享时去掉它；工作树与 HEAD 由 provenance 提供。
  const sharedContent = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "project"));
  const sharedModel = sharedContent(model);
  const currentIds = await repository.currentObjectIds();
  const modelSnapshots = (await Promise.all(currentIds.map(async id => {
    const object = await repository.readObject(id);
    if (object.object_type !== "module_snapshot") return undefined;
    const snapshot = ModuleSnapshotSchema.parse(object.content);
    return snapshot.model_id === modelId ? { id, snapshot, object } : undefined;
  }))).filter((item): item is { id: string; snapshot: ModuleSnapshot; object: ObjectEnvelope } => !!item);
  // 重新准备旧工作树时，已有模型正文只引用原来的证据快照。无关提交或 staged 状态
  // 变化不能把同一修订重新发布为另一个候选。
  const published = modelSnapshots.find(item => JSON.stringify(item.snapshot.content) === JSON.stringify(sharedModel));
  if (published && !options.receipt) return { snapshot_id: published.id, source_stamp_id: published.snapshot.provenance?.source_stamp_id ?? published.id };
  // 文件内容变化的局部修订也属于同一条谱系。通过旧模型正文定位其原快照，
  // 避免将普通修订误判为两个并行模型。
  const base = options.base_model && JSON.stringify(sharedContent(options.base_model));
  const anchor = base && modelSnapshots.find(item => JSON.stringify(item.snapshot.content) === base);
  // related_versions 保存直接证据和关联实现路径。配置/依赖也必须进入同一份
  // 快照，否则 package/lock/tsconfig 变化后仍可能复用旧业务结论。
  const source_stamp = await collectSourceStamp(binding, { paths: related.map(item => item.path), includeConfiguration: true });
  const evidence_stamp_id = evidenceStampId(source_stamp);
  const configurationPaths = new Set(source_stamp.configuration.map(item => item.path));
  const sourcePaths = new Set(Array.isArray(model.sources)
    ? model.sources.flatMap(item => typeof item === "object" && item !== null && "path" in item && typeof item.path === "string" ? [item.path] : [])
    : []);
  // 旧版影子写入可能只有 related_versions，没有 sources。此时保持旧语义，
  // 将非配置路径视为源码证据，避免升级后所有历史候选都因 source_evidence_missing 消失。
  const hasExplicitSourcePaths = sourcePaths.size > 0;
  const source_fingerprints = related.filter(item => !configurationPaths.has(item.path) && (!hasExplicitSourcePaths || sourcePaths.has(item.path)));
  const dependency_fingerprints = related.filter(item => !configurationPaths.has(item.path) && hasExplicitSourcePaths && !sourcePaths.has(item.path));
  const configuration_fingerprints = source_stamp.configuration.filter(item => isConfigurationPath(item.path));
  // 同一业务模型修订在共享回执保存失败后会再次构造快照；使用模型自身的
  // immutable recorded_at 作为 provenance 时间，避免重试仅因当前时间变化而
  // 产生新的 snapshot_id。
  const recordedAt = typeof model.recorded_at === "string" ? model.recorded_at : new Date().toISOString();
  const currentSources = new Map(related.map((item) => [item.path, item.sha256]));
  const priorCandidates = modelSnapshots.flatMap(({ id, snapshot }) => {
      const previousContent = snapshot.content;
      const previousRevision = typeof previousContent === "object" && previousContent !== null && typeof (previousContent as Record<string, unknown>).revision === "number"
        ? (previousContent as Record<string, unknown>).revision as number : 0;
      const lineage = snapshot.source_fingerprints.every((item) => currentSources.get(item.path) === item.sha256);
      return previousRevision < revision && lineage
        ? [{ id, revision: previousRevision, evidence: new Set(snapshot.source_fingerprints.map(item => `${item.path}:${item.sha256}`)) }]
        : [];
  });
  // 组合当前源码时保留所有“最大父快照”：同一工作树的旧修订被更高修订
  // 支配，A/B 两个同级来源则同时保留，避免把分支整合误记成单父覆盖。
  const parents = priorCandidates.filter(candidate => !priorCandidates.some(other => {
    if (other.id === candidate.id || other.revision < candidate.revision || other.evidence.size < candidate.evidence.size) return false;
    const superset = [...candidate.evidence].every(key => other.evidence.has(key));
    return superset && (other.revision > candidate.revision || other.evidence.size > candidate.evidence.size);
  })).sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id));
  const baseContent = { model_id: modelId, module: typeof model.module === "string" ? model.module : modelId,
    parent_snapshot_ids: options.parent_snapshot_ids ?? (anchor ? [anchor.id] : parents.map(parent => parent.id)), basis,
    source_fingerprints: source_fingerprints.map((item) => ({ path: item.path, sha256: item.sha256 })),
    dependency_fingerprints: dependency_fingerprints.map((item) => ({ path: item.path, sha256: item.sha256 })),
    configuration_fingerprints, trust: { state: "candidate" as const, reason: "model_record_requires_review" }, content: sharedModel } satisfies ModuleSnapshot;
  const snapshot = {
    ...baseContent,
    provenance: { repo_identity: binding.repo_identity, worktree_id: digest(`${binding.repo_identity}\n${binding.root}`), head: source_stamp.head, source_stamp_id: evidence_stamp_id, recorded_at: recordedAt },
  } satisfies ModuleSnapshot;
  const parsed = published?.object ?? ObjectEnvelopeSchema.parse({ schema_version: 1, object_type: "module_snapshot",
    object_id: digest(JSON.stringify(snapshot)), content: snapshot });
  let objects = [parsed];
  let receipt_id: string | undefined;
  if (options.receipt) {
    const receipt: ProjectKnowledgeApplyReceipt = ProjectKnowledgeApplyReceiptSchema.parse({
      schema_version: 1,
      kind: "model_apply",
      ...options.receipt,
      repo_identity: binding.repo_identity,
      worktree_id: digest(`${binding.repo_identity}\n${binding.root}`),
      head: source_stamp.head,
      source_stamp_id: source_stamp.stamp_id,
      snapshot_id: parsed.object_id,
      model_id: modelId,
      model_revision: revision,
      applied_at: new Date().toISOString(),
    });
    receipt_id = digest(JSON.stringify(receipt));
    objects.push(ObjectEnvelopeSchema.parse({ schema_version: 1, object_type: "receipt", object_id: receipt_id, content: receipt }));
  }
  // 普通模型影子写入也把最终快照 ID 纳入 operation，避免同一工作树上
  // 两个同 revision 但来源范围不同的候选互相占用同一个操作号；同内容
  // 重试仍保持幂等。
  const operation_id = options.receipt?.operation_id ?? `model-shadow:${modelId}:${revision}:${parsed.object_id}`;
  // 旧版本在共享库已写入模型、但本地回执丢失时，重试会重新生成 applied_at，
  // 从而得到不同 receipt hash。复用已有 operation 中的不可变对象，仍让
  // repository.publish 负责把该事务接回 CURRENT 链尾。
  const existingOperation = await repository.readOperation(operation_id);
  if (existingOperation) {
    const existingObjects = await Promise.all(existingOperation.object_ids.map(id => repository.readObject(id)));
    const existingSnapshot = existingObjects.find(object => object.object_type === "module_snapshot");
    if (!existingSnapshot || existingSnapshot.object_id !== parsed.object_id)
      throw new AppError("PROJECT_KNOWLEDGE_OPERATION_CONFLICT", "同一模型应用操作号对应了不同的源码快照");
    if (options.receipt && !existingObjects.some(object => object.object_type === "receipt"))
      throw new AppError("PROJECT_KNOWLEDGE_OPERATION_CONFLICT", "同一模型应用操作号缺少共享应用回执");
    objects = existingOperation.object_ids.map(id => objects.find(object => object.object_id === id) ?? existingObjects.find(object => object.object_id === id)!).filter((object): object is ObjectEnvelope => Boolean(object));
    receipt_id = existingObjects.find(object => object.object_type === "receipt")?.object_id ?? receipt_id;
  }
  await repository.publish({ operation_id, objects, ...(options.expected_transaction_id !== undefined ? { expected_transaction_id: options.expected_transaction_id } : {}) });
  return { snapshot_id: parsed.object_id, ...(receipt_id ? { receipt_id } : {}), source_stamp_id: source_stamp.stamp_id };
}

function snapshotDescendsFrom(snapshots: Map<string, ModuleSnapshot>, currentId: string, ancestorId: string): boolean {
  const pending = [currentId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === ancestorId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(snapshots.get(id)?.parent_snapshot_ids ?? []));
  }
  return false;
}

function taskCoversAllModelRules(task: Awaited<ReturnType<TaskStore["load"]>>, model: ReturnType<typeof worktreeModel>, reviewToken: string): boolean {
  if (!model || model.schema_version === 1) return false;
  const planned = new Set(task.business_plans?.at(-1)?.input.rules.filter(item => item.model_id === model.id).map(item => item.rule_id));
  const checked = new Set(task.acceptance_criteria.filter(item => item.status === "checked" && item.review_snapshot === reviewToken
    && item.business_check?.model_id === model.id).map(item => item.business_check!.rule_id));
  return model.rules.every(rule => planned.has(rule.id) || checked.has(rule.id));
}

/**
 * 将已完成任务的候选快照提升为 verified。
 *
 * 验证只创建新的不可变快照，不修改候选对象，也不接受模型正文或外部
 * 传入的 verified 标志。提交前再次核对当前源码唯一匹配、计划基线、
 * 全部规则验收和当前事务，避免并行工作树或部分验收把旧结论标成最新。
 */
export async function publishModelVerification(binding: WorktreeBinding, rawInput: ModelVerificationInput): Promise<{ snapshot_id: string; source_stamp_id: string }> {
  const input = ModelVerificationInputSchema.parse(rawInput);
  const task = await new TaskStore(binding.root).load(input.task_id);
  if (task.repo_identity !== binding.repo_identity || task.worktree_path !== binding.root || task.phase !== "closed")
    throw new AppError("PROJECT_MODEL_VERIFICATION_TASK_REQUIRED", "只有当前工作树已关闭且完成验收的任务才能提升模型可信度");
  const reviewSnapshots = new Set([
    ...task.acceptance_criteria.map(item => item.review_snapshot),
    ...task.change_items.map(item => item.review_snapshot),
    ...task.validations.map(item => item.review_snapshot),
  ].filter((value): value is string => typeof value === "string"));
  if (!reviewSnapshots.has(input.review_snapshot) || task.acceptance_criteria.some(item => item.status !== "checked"))
    throw new AppError("PROJECT_MODEL_VERIFICATION_REVIEW_REQUIRED", "模型可信度回写必须关联已关闭任务的验收快照");
  const currentReviewSnapshot = (await reviewSnapshot(binding, task.baseline_head, task.workspace_baseline)).hash;
  if (currentReviewSnapshot !== input.review_snapshot)
    throw new AppError("PROJECT_MODEL_VERIFICATION_REVIEW_REQUIRED", "模型可信度回写使用了旧的验收快照，请在当前工作树重新核验后再关闭任务");
  const repository = await ProjectKnowledgeRepository.openExisting(binding.repo_identity);
  if (!repository) throw new AppError("PROJECT_KNOWLEDGE_UNAVAILABLE", "项目知识库不存在，无法记录模型验证");
  const currentIds = await repository.currentObjectIds();
  if (!currentIds.includes(input.snapshot_id)) throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "待验证模型快照已不在当前项目知识库中");
  const objects = await Promise.all(currentIds.map(id => repository.readObject(id)));
  const snapshots = new Map<string, ModuleSnapshot>();
  for (const object of objects) if (object.object_type === "module_snapshot") snapshots.set(object.object_id, ModuleSnapshotSchema.parse(object.content));
  const snapshot = snapshots.get(input.snapshot_id);
  if (!snapshot) throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "待验证对象不是模块快照");
  if (snapshot.model_id !== input.model_id) throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "待验证快照与模型身份不匹配");
  const priorTrust = modelTrust(snapshot.trust);
  const currentModel = worktreeModel(binding.root, snapshot.content, input.model_id);
  if (!taskCoversAllModelRules(task, currentModel, input.review_snapshot))
    throw new AppError("PROJECT_MODEL_VERIFICATION_REVIEW_REQUIRED", "当前任务没有覆盖该业务模型的全部规则，模型继续保持候选状态");
  if (input.base_snapshot_id && !snapshotDescendsFrom(snapshots, input.snapshot_id, input.base_snapshot_id))
    throw new AppError("PROJECT_MODEL_VERIFICATION_REVIEW_REQUIRED", "当前模型快照不属于任务计划记录的模型基线，请重新读取并复核");
  const paths = [...new Set([...snapshot.source_fingerprints, ...snapshot.dependency_fingerprints].map(item => item.path))];
  const source_stamp = await collectSourceStamp(binding, { paths, includeConfiguration: true });
  const view = resolveKnowledgeView({ source_stamp, snapshots: objects });
  const selected = view.modules.find(item => item.model_id === input.model_id);
  if (!selected || selected.state !== "matched" || selected.selected_snapshot_id !== input.snapshot_id)
    throw new AppError("PROJECT_MODEL_VERIFICATION_REVIEW_REQUIRED", "当前源码没有唯一匹配到待验证快照，请重新核对模型和并行分支后再验证");
  if (isVerifiedTrust(priorTrust, selected.state)) return { snapshot_id: input.snapshot_id, source_stamp_id: source_stamp.stamp_id };
  const verified = ModuleSnapshotSchema.parse({ ...snapshot, parent_snapshot_ids: [input.snapshot_id],
    trust: { state: "verified", reason: "task_review_and_validation_passed", source_stamp_id: source_stamp.stamp_id,
      review_snapshot: input.review_snapshot, verified_at: new Date().toISOString(), verified_by: `task:${input.task_id}` } });
  const envelope = ObjectEnvelopeSchema.parse({ schema_version: 1, object_type: "module_snapshot",
    object_id: digest(JSON.stringify(verified)), content: verified });
  await repository.publish({ operation_id: input.operation_id, objects: [envelope], ...(input.expected_transaction_id !== undefined ? { expected_transaction_id: input.expected_transaction_id } : {}) });
  return { snapshot_id: envelope.object_id, source_stamp_id: source_stamp.stamp_id };
}
