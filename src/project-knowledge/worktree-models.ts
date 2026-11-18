import type { WorktreeBinding } from "../git/baseline.js";
import { loadConfig, type ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import { SavedModelSchema, type SavedModel } from "../understanding/model-contracts.js";
import { excluded } from "../understanding/scan.js";
import { models } from "../understanding/store.js";
import { readProjectKnowledge, type ProjectKnowledgeStatus } from "./service.js";

/** 共享模型正文不保存绝对路径；只为当前工作树还原阅读所需的位置字段。 */
export function worktreeModel(root: string, content: unknown, id: string): SavedModel | undefined {
  if (!content || typeof content !== "object") return undefined;
  const model = SavedModelSchema.safeParse({ ...content, project: root });
  return model.success && model.data.id === id ? model.data : undefined;
}

/** 所有查询使用同一套文件排除规则，包括其他工作树发布的共享快照。 */
export function modelVisible(model: SavedModel, config: ProjectConfig): boolean {
  return model.related_paths.every(path => !excluded(path, config)) &&
    model.sources.every(source => !("path" in source) || !excluded(source.path, config));
}

/**
 * 以经当前源码核验的共享快照替代本地副本。歧义和覆盖不足的模块禁止回退；
 * 只有唯一旧快照需要复核时，才保留本地记录作为逐条核对的候选。
 */
export async function readWorktreeModels(files: ProjectFiles, knowledge?: ProjectKnowledgeStatus) {
  if (knowledge?.state === "unverified") return { models: [], snapshotIds: new Map<string, string>() };
  // 匹配的共享版本若被排除或正文损坏，同样不能退回同 ID 的旧本地规则。
  const hidden = new Set(knowledge?.modules?.filter(item => item.state !== "needs_review")
    .map(item => item.model_id));
  const selected = new Map<string, SavedModel>();
  const snapshotIds = new Map<string, string>();
  for (const snapshot of knowledge?.selected_models ?? []) {
    const model = worktreeModel(files.root, snapshot.content, snapshot.model_id);
    if (model) {
      selected.set(model.id, model);
      snapshotIds.set(model.id, snapshot.snapshot_id);
    } else hidden.add(snapshot.model_id);
  }
  const local = await models(files);
  return { models: [...local.filter(model => !hidden.has(model.id) && !selected.has(model.id)), ...selected.values()], snapshotIds };
}

/** 任务和验收入口复用同一套当前工作树选型，禁止使用歧义候选当作当前规则。 */
export async function loadWorktreeModels(binding: WorktreeBinding, files = new ProjectFiles(binding.root)) {
  const knowledge = await readProjectKnowledge(binding);
  const { config } = await loadConfig(files);
  const view = await readWorktreeModels(files, knowledge);
  return { knowledge, config, snapshotIds: view.snapshotIds,
    models: knowledge.state === "unavailable" ? [] : view.models.filter(model => modelVisible(model, config)) };
}
