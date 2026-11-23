import type { ProjectConfig } from "../knowledge/config.js";
import { SavedModelSchema, type SavedModel } from "../understanding/model-contracts.js";
import { excluded } from "../understanding/scan.js";

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
