import type { WorktreeBinding } from "../git/baseline.js";
import { loadConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import type { SavedModel } from "../understanding/model-contracts.js";
import { isUsableModelTrust } from "./model-trust.js";
import { modelVisible, worktreeModel } from "./model-visibility.js";
export { modelVisible, worktreeModel } from "./model-visibility.js";
import { models } from "../understanding/store.js";
import { excluded } from "../understanding/scan.js";
import { readProjectKnowledge, type ProjectKnowledgeStatus } from "./service.js";

/**
 * 以经当前源码核验的共享快照替代本地副本。歧义和覆盖不足的模块禁止回退；
 * 只有唯一旧快照需要复核时，才保留本地记录作为逐条核对的候选。
 */
export async function readWorktreeModels(files: ProjectFiles, knowledge?: ProjectKnowledgeStatus) {
  const local = await models(files);
  // 共享视图未完成核验时，所有本地模型都只能作为复核候选。
  // 这里不能让旧工作树记录穿过 generation 链路，否则新分支会继续使用旧业务结论。
  if (knowledge?.state === "unverified" || knowledge?.state === "unavailable"
    || (knowledge && ["needs_review", "partial"].includes(knowledge.state) && !knowledge.modules?.length)) {
    return { models: [], reviewCandidates: local, snapshotIds: new Map<string, string>() };
  }
  // 匹配的共享版本若被排除或正文损坏，同样不能退回同 ID 的旧本地规则。
  // needs_review、ambiguous 和 partial 都是未完成核验，不能再作为当前模型。
  const selectedIds = new Set(knowledge?.selected_models?.map(item => item.model_id));
  // matched 但没有正文的模块通常是当前配置过滤掉了共享快照，或共享
  // 快照已损坏。此时连本地旧副本也不能作为复核候选展示，避免把被
  // 明确排除的共享修订降级成同 ID 的旧模型。
  const matchedWithoutSelected = new Set(knowledge?.modules?.filter(item => item.state === "matched" && !selectedIds.has(item.model_id)).map(item => item.model_id));
  const blocked = new Set(knowledge?.modules?.filter(item => item.state !== "matched"
    || (item.state === "matched" && !selectedIds.has(item.model_id))).map(item => item.model_id));
  const hidden = new Set(blocked);
  // 明确降级的快照不能提供实施依据，即使文件指纹仍然完全匹配。
  const denied = new Set((knowledge?.selected_models ?? []).filter(item =>
    !isUsableModelTrust(item.trust)).map(item => item.model_id));
  for (const id of denied) hidden.add(id);
  const selected = new Map<string, SavedModel>();
  const snapshotIds = new Map<string, string>();
  for (const snapshot of knowledge?.selected_models ?? []) {
    if (denied.has(snapshot.model_id)) continue;
    const model = worktreeModel(files.root, snapshot.content, snapshot.model_id);
    if (model) {
      selected.set(model.id, model);
      snapshotIds.set(model.id, snapshot.snapshot_id);
    } else hidden.add(snapshot.model_id);
  }
  const reviewCandidates = local.filter(model => blocked.has(model.id) && !matchedWithoutSelected.has(model.id));
  return { models: [...local.filter(model => !hidden.has(model.id) && !selected.has(model.id)), ...selected.values()], reviewCandidates, snapshotIds };
}

/** 任务和验收入口复用同一套当前工作树选型，禁止使用歧义候选当作当前规则。 */
export async function loadWorktreeModels(binding: WorktreeBinding, files = new ProjectFiles(binding.root), focusRules?: Set<string>) {
  const knowledge = await readProjectKnowledge(binding, focusRules ? { focusRules } : {});
  const { config } = await loadConfig(files);
  const view = await readWorktreeModels(files, knowledge);
  const excludedBySharedEvidence = new Set((knowledge.modules ?? []).filter(module => module.reasons.some(reason => {
    const path = reason.startsWith("source_missing:") ? reason.slice("source_missing:".length) : undefined;
    return !!path && excluded(path, config);
  })).map(module => module.model_id));
  return { knowledge, config, snapshotIds: view.snapshotIds,
    models: knowledge.state === "unavailable" ? [] : view.models.filter(model => modelVisible(model, config)),
    reviewCandidates: view.reviewCandidates.filter(model => !excludedBySharedEvidence.has(model.id) && modelVisible(model, config)) };
}
