import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/baseline.js";
import type { ProjectConfig } from "../knowledge/config.js";
import { modelTrust } from "../project-knowledge/model-trust.js";
import { modelVisible, worktreeModel } from "../project-knowledge/model-visibility.js";
import { readProjectKnowledge } from "../project-knowledge/service.js";
import type { SourceStamp } from "../project-knowledge/source-stamp.js";
import type { ModuleSnapshot } from "../project-knowledge/view-resolver.js";
import { modificationScope } from "../quality/business-plan.js";
import type { BusinessPlanRecord } from "../quality/business-plan-contracts.js";
import { activeBusinessDeltas, ruleKey } from "../quality/business-plan-targets.js";

/** 计划内修改只允许已有普通文件内容发生变化。配置、缺失来源和范围外依赖仍需复核。 */
function onlyPlannedChanges(snapshot: ModuleSnapshot, stamp: SourceStamp, scope: ReadonlyMap<string, unknown>) {
  const configuration = new Map(stamp.configuration.map(item => [item.path, item.sha256]));
  if (snapshot.configuration_fingerprints.some(item => configuration.get(item.path) !== item.sha256)) return false;
  if (snapshot.provenance && stamp.configuration.some(item => item.sha256 && !snapshot.configuration_fingerprints.some(old => old.path === item.path))) return false;
  const entries = new Map(stamp.entries.map(item => [item.path, item]));
  let modified = false;
  for (const expected of [...snapshot.source_fingerprints, ...snapshot.dependency_fingerprints]) {
    const current = entries.get(expected.path);
    if (!current || current.kind !== "file" || !expected.sha256 || !current.sha256) return false;
    if (current.sha256 === expected.sha256) continue;
    if (!scope.has(expected.path) || configuration.has(expected.path)) return false;
    modified = true;
  }
  return modified;
}

/** 每次写入沿用开工时绑定的共享快照；已变的源码只在本计划允许的范围内放行。 */
export async function plannedModelWriteIssues(binding: WorktreeBinding, task: Pick<Task, "business_deltas">, plan: BusinessPlanRecord): Promise<string[]> {
  const deltas = activeBusinessDeltas(task);
  const newModels = new Set(deltas.filter(delta => delta.input.new_model).map(delta => delta.input.model_id));
  const modelIds = new Set(plan.input.rules.map(rule => rule.model_id).filter(id => !newModels.has(id)));
  if (!modelIds.size) return [];
  const focusRules = new Set(plan.input.rules.map(ruleKey));
  const snapshots = new Map<string, ModuleSnapshot>();
  const evidence: { stamp?: SourceStamp; config?: ProjectConfig } = {};
  const view = await readProjectKnowledge(binding, { focusRules, reviewedSnapshots: snapshots, evidence });
  if (!evidence.config || !evidence.stamp?.coverage.complete || !view.modules) return [view.state];

  const scope = modificationScope(plan);
  const issues = (view.rule_reviews?.items ?? [])
    .filter(item => focusRules.has(ruleKey(item)) && (!scope.has(item.path) || item.kind === "configuration" || item.kind === "evidence_revision"))
    .map(item => `${item.model_id}/${item.rule_id}:${item.kind}`);
  for (const id of modelIds) {
    const module = view.modules.find(item => item.model_id === id);
    // 旧任务在业务草案里保存过不可变基线。缺少基线的旧计划只能沿用当前仍然匹配的模型。
    const oldPins = new Set(deltas.filter(delta => delta.input.model_id === id).map(delta => delta.base_snapshot_id));
    const pin = plan.base_snapshot_ids?.find(item => item.model_id === id)?.snapshot_id ?? (oldPins.size === 1 ? [...oldPins][0] : undefined);
    const snapshotId = module?.state === "matched" ? module.selected_snapshot_id : pin;
    const snapshot = snapshotId && snapshots.get(snapshotId);
    const model = snapshot && worktreeModel(binding.root, snapshot.content, id);
    if (!snapshot || !model || !modelVisible(model, evidence.config) || !["candidate", "verified"].includes(modelTrust(snapshot.trust).state)) {
      issues.push(`${id}:model_unavailable`);
      continue;
    }
    if (module?.state === "matched") {
      // 验收提升会创建同正文子快照；其他修订须重新核对计划。
      if (pin && pin !== snapshotId && JSON.stringify(snapshots.get(pin)?.content) !== JSON.stringify(snapshot.content))
        issues.push(`${id}:baseline_changed`);
      continue;
    }
    // needs_review 时解析器返回唯一谱系末端作为第一个候选，其他状态禁止借旧版本恢复写入。
    if (module?.state !== "needs_review" || !pin || !module.candidate_snapshot_ids.includes(pin) || !onlyPlannedChanges(snapshot, evidence.stamp, scope))
      issues.push(`${id}:${module?.state ?? "missing"}`);
  }
  return issues;
}
