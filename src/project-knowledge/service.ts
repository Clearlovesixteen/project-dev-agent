import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/baseline.js";
import { ProjectKnowledgeRepository } from "./repository.js";
import { collectSourceStamp, type SourceStamp } from "./source-stamp.js";
import { resolveKnowledgeView, type KnowledgeView, type ModuleSnapshot } from "./view-resolver.js";
import { ObjectEnvelopeSchema } from "./contracts.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ProjectKnowledgeStatus {
  state: "not_initialized" | "empty" | "matched" | "needs_review" | "partial" | "unavailable";
  project_id?: string;
  transaction_id?: string;
  snapshot_count: number;
  source_stamp_id?: string;
  view_token?: string;
  modules?: KnowledgeView["modules"];
  unresolved?: string[];
  coverage?: SourceStamp["coverage"];
  message?: string;
}

/** 读取项目共享知识的当前视图；普通查询只读，不会创建项目库或改写快照。 */
export async function readProjectKnowledge(binding: WorktreeBinding): Promise<ProjectKnowledgeStatus> {
  const repository = await ProjectKnowledgeRepository.openExisting(binding.repo_identity);
  if (!repository) return { state: "not_initialized", snapshot_count: 0 };
  try {
    const identity = await repository.files.readIdentity();
    const pointer = await repository.current();
    if (!identity) throw new AppError("PROJECT_KNOWLEDGE_IDENTITY_MISSING", "项目知识库缺少身份记录");
    if (!pointer) return { state: "empty", project_id: identity.project_id, snapshot_count: 0 };
    const source_stamp = await collectSourceStamp(binding);
    const objectIds = await repository.currentObjectIds();
    const objects = await Promise.all(objectIds.map((id) => repository.readObject(id)));
    const view = resolveKnowledgeView({ source_stamp, snapshots: objects });
    const state = view.modules.length === 0 ? "empty" : view.modules.some((item) => item.state === "partial") ? "partial" : view.unresolved.length ? "needs_review" : "matched";
    return { state, project_id: identity.project_id, transaction_id: pointer.transaction_id, snapshot_count: objectIds.length,
      source_stamp_id: source_stamp.stamp_id, view_token: view.view_token, modules: view.modules, unresolved: view.unresolved, coverage: source_stamp.coverage };
  } catch (error) {
    if (error instanceof AppError && error.code === "VIEW_CHANGED") return { state: "needs_review", snapshot_count: 0, message: "读取期间工作树发生变化，请在下一次查询重新核验" };
    return { state: "unavailable", snapshot_count: 0, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 将当前工作树的已保存模型以不可变快照写入项目库；失败不回滚本地模型。 */
export async function publishModelShadow(binding: WorktreeBinding, model: Record<string, unknown>): Promise<{ snapshot_id: string }> {
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
  const content = { model_id: modelId, module: typeof model.module === "string" ? model.module : modelId, parent_snapshot_ids: [], basis,
    source_fingerprints: related.map((item) => ({ path: item.path, sha256: item.sha256 })), dependency_fingerprints: [], configuration_fingerprints: [], content: model } satisfies ModuleSnapshot;
  const parsed = ObjectEnvelopeSchema.parse({ schema_version: 1, object_type: "module_snapshot", object_id: digest(JSON.stringify(content)), content });
  await repository.publish({ operation_id: `model-shadow:${modelId}:${revision}:${digest(JSON.stringify(related))}`, objects: [parsed] });
  return { snapshot_id: parsed.object_id };
}
