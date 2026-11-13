import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/baseline.js";
import { ProjectKnowledgeRepository } from "./repository.js";
import { collectSourceStamp, type SourceStamp } from "./source-stamp.js";
import { ModuleSnapshotSchema, resolveKnowledgeView, type KnowledgeView, type ModuleSnapshot } from "./view-resolver.js";
import { ObjectEnvelopeSchema, type ProjectIdentity, type SnapshotPointer } from "./contracts.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ProjectKnowledgeStatus {
  state: "not_initialized" | "empty" | "matched" | "needs_review" | "partial" | "unavailable";
  project_id?: string;
  transaction_id?: string;
  snapshot_count: number;
  source_stamp_id?: string;
  view_token?: string;
  modules?: KnowledgeView["modules"];
  /** 当前源码确实匹配的共享模型正文；歧义/过期时不返回，避免 Codex 误用旧分支结论。 */
  selected_models?: Array<{ snapshot_id: string; model_id: string; module: string; basis: ModuleSnapshot["basis"]; content: unknown; provenance?: ModuleSnapshot["provenance"] }>;
  unresolved?: string[];
  coverage?: SourceStamp["coverage"];
  message?: string;
}

/** 读取项目共享知识的当前视图；普通查询只读，不会创建项目库或改写快照。 */
export async function readProjectKnowledge(binding: WorktreeBinding): Promise<ProjectKnowledgeStatus> {
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
    const source_stamp = await collectSourceStamp(binding);
    const objectIds = await opened.currentObjectIds();
    const objects = await Promise.all(objectIds.map((id) => opened.readObject(id)));
    const view = resolveKnowledgeView({ source_stamp, snapshots: objects });
    const state = view.modules.length === 0 ? "empty" : view.modules.some((item) => item.state === "partial") ? "partial" : view.unresolved.length ? "needs_review" : "matched";
    const selected_models = view.selected_snapshot_ids.map((id) => {
      const object = objects.find((item) => item.object_id === id);
      if (!object || object.object_type !== "module_snapshot") return undefined;
      const snapshot = ModuleSnapshotSchema.parse(object.content);
      return { snapshot_id: id, model_id: snapshot.model_id, module: snapshot.module, basis: snapshot.basis, content: snapshot.content, ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}) };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { state, project_id: identity.project_id, transaction_id: pointer.transaction_id, snapshot_count: objectIds.length,
      source_stamp_id: source_stamp.stamp_id, view_token: view.view_token, modules: view.modules, selected_models, unresolved: view.unresolved, coverage: source_stamp.coverage };
  } catch (error) {
    const common = { ...(identity?.project_id ? { project_id: identity.project_id } : {}), ...(pointer?.transaction_id ? { transaction_id: pointer.transaction_id } : {}), snapshot_count: pointer?.object_ids.length ?? 0 };
    if (error instanceof AppError && error.code === "VIEW_CHANGED") return {
      state: "needs_review", ...common, message: "读取期间工作树发生变化，请在下一次查询重新核验",
    };
    return { state: "unavailable", ...common, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 将当前工作树的已保存模型以不可变快照写入项目库；失败不回滚本地模型。 */
export async function publishModelShadow(binding: WorktreeBinding, model: Record<string, unknown>): Promise<{ snapshot_id: string }> {
  const repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const source_stamp = await collectSourceStamp(binding);
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
  const sharedModel = Object.fromEntries(Object.entries(model).filter(([key]) => key !== "project"));
  const currentIds = await repository.currentObjectIds();
  const prior = (await Promise.all(currentIds.map(async (id) => {
    try {
      const object = await repository.readObject(id);
      if (object.object_type !== "module_snapshot") return undefined;
      const parsed = ModuleSnapshotSchema.safeParse(object.content);
      if (!parsed.success || parsed.data.model_id !== modelId) return undefined;
      const previousContent = parsed.data.content;
      const previousRevision = typeof previousContent === "object" && previousContent !== null && typeof (previousContent as Record<string, unknown>).revision === "number"
        ? (previousContent as Record<string, unknown>).revision as number : 0;
      return previousRevision < revision ? { id, revision: previousRevision } : undefined;
    } catch { return undefined; }
  }))).filter((item): item is { id: string; revision: number } => Boolean(item))
    .sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id))[0];
  const baseContent = { model_id: modelId, module: typeof model.module === "string" ? model.module : modelId, parent_snapshot_ids: prior ? [prior.id] : [], basis,
    source_fingerprints: related.map((item) => ({ path: item.path, sha256: item.sha256 })), dependency_fingerprints: [], configuration_fingerprints: [], content: sharedModel } satisfies ModuleSnapshot;
  const snapshot = {
    ...baseContent,
    provenance: { repo_identity: binding.repo_identity, worktree_id: digest(`${binding.repo_identity}\n${binding.root}`), head: source_stamp.head, source_stamp_id: source_stamp.stamp_id, recorded_at: new Date().toISOString() },
  } satisfies ModuleSnapshot;
  const parsed = ObjectEnvelopeSchema.parse({ schema_version: 1, object_type: "module_snapshot", object_id: digest(JSON.stringify(snapshot)), content: snapshot });
  await repository.publish({ operation_id: `model-shadow:${modelId}:${revision}:${source_stamp.stamp_id}`, objects: [parsed] });
  return { snapshot_id: parsed.object_id };
}
