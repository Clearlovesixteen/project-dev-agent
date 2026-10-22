import type { WorktreeBinding } from "../git/index.js";
import type { Task } from "../domain/task.js";
import { ProjectFiles } from "../storage/project-files.js";
import { TaskStore } from "../storage/task-store.js";
import { loadConfig } from "../knowledge/config.js";
import { mapFiles, models, readMap } from "../understanding/store.js";
import { mapConfigHash, excluded } from "../understanding/scan.js";
import { ModelEvidence, sourcePath } from "../understanding/model-evidence.js";
import { materializeModel, relatedModelIds } from "../understanding/model-view.js";
import { auditModels } from "../understanding/model-audit.js";
import { businessScenarios } from "./scenarios.js";
import { impactCandidates } from "./impact.js";
import { evaluateTasks } from "./evaluation.js";
const intersects = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** 复用已有 task_check；分析不可用时保留原任务检查结果，不能把“没有提示”当作检查通过。 */
export async function qualityReview(binding: WorktreeBinding, task: Task, changed: string[], snapshot: string) {
  try {
    const files = new ProjectFiles(binding.root), map = await readMap(files);
    if (!map) return { state: "not_scanned", next_step: "调用 project_scan 后获取关联位置与业务场景。" };
    const { config } = await loadConfig(files);
    const entries = (await mapFiles(files)).filter(entry => !excluded(entry.path, config));
    const visible = (await models(files)).filter(model => model.related_paths.every(path => !excluded(path, config))
      && model.sources.every(source => { const path = sourcePath(source); return !path || !excluded(path, config); }));
    const paths = [...new Set([...changed, ...task.change_items.map(item => item.target_path)])].filter(path => !excluded(path, config));
    const direct = visible.filter(model => [...model.scope, ...model.related_paths].some(path => paths.some(seed => intersects(path, seed)))
      || task.acceptance_criteria.some(item => item.business_check?.model_id === model.id));
    const ids = new Set(direct.map(model => model.id)), related = relatedModelIds(visible, ids);
    const selected = [...direct, ...visible.filter(model => !ids.has(model.id) && related.has(model.id))];
    const evidence = new ModelEvidence(files, config, new Map(entries.map(entry => [entry.path, entry])), binding.repo_identity);
    const views = await Promise.all(selected.slice(0, 5).map(model => materializeModel(model, evidence, visible)));
    const indexed = new Map(entries.map(entry => [entry.path, entry]));
    const sourceStates = await Promise.all(paths.slice(0, 30).map(async path => {
      if (indexed.has(path)) return evidence.pathState(path, indexed.get(path)!.sha256);
      return await evidence.pathState(path, "") === "changed" ? "unindexed" : "missing_after_scan";
    }));
    const indexStale = map.head !== binding.head || map.config_hash !== await mapConfigHash(files, config) || sourceStates.some(state => state !== "current" && state !== "missing_after_scan");
    const scenarios = businessScenarios(views, task, snapshot, 10);
    const impact = impactCandidates(entries, visible, paths, new Set(task.change_items.map(item => item.target_path)), 15);
    const scripts = entries.filter(entry => entry.package).flatMap(entry => entry.package!.scripts.filter(script => /(?:test|lint|typecheck|check)(?:$|:|-)/i.test(script))
      .map(script => ({ manifest: entry.path, script }))).slice(0, 10);
    return { state: "advisory", index_state: indexStale ? "needs_rescan" : "current", freshness_truncated: paths.length > 30, impact, business_checks: scenarios, model_audit: auditModels(visible, new Set(selected.map(model => model.id))),
      available_validation_scripts: scripts, models_truncated: selected.length > 5,
      next_step: "核对未进入清单的关联线索；将适用业务场景的 business_check 写入现有验收项并实际验证，不适用项说明依据。先解决规则分歧，不能只因工具给出建议就新增无关改动。" };
  } catch (error) { return { state: "unavailable", message: error instanceof Error ? error.message : String(error) }; }
}

/** 统计按请求读取；日常执行者在收尾时请求一次，不在每次中间检查重复遍历历史。 */
export async function projectEvaluation(binding: WorktreeBinding) {
  try {
    const records = await new TaskStore(binding.root).list();
    return evaluateTasks(records.tasks.filter(task => task.repo_identity === binding.repo_identity), records.truncated);
  } catch (error) { return { state: "unavailable", message: error instanceof Error ? error.message : String(error) }; }
}

/** 仅对任务显式采用的业务场景执行关闭保护；未知关联线索不强制扩大任务范围。 */
export async function assertBusinessAcceptance(binding: WorktreeBinding, task: Task, snapshot: string) {
  if (!task.acceptance_criteria.some(item => item.business_check)) return;
  const files = new ProjectFiles(binding.root), map = await readMap(files);
  if (!map) throw new Error("绑定业务验收的任务缺少结构索引，请先扫描并复核。");
  const { config } = await loadConfig(files);
  const visible = (await models(files)).filter(model => model.related_paths.every(path => !excluded(path, config))
    && model.sources.every(source => { const path = sourcePath(source); return !path || !excluded(path, config); }));
  const evidence = new ModelEvidence(files, config, new Map((await mapFiles(files)).map(entry => [entry.path, entry])), binding.repo_identity, new Map([[task.id, task]]));
  const ids = new Set(task.acceptance_criteria.flatMap(item => item.business_check ? [item.business_check.model_id] : []));
  for (const id of ids) {
    const model = visible.find(item => item.id === id);
    if (!model) throw new Error(`业务验收引用的模型不可访问：${id}`);
    const view = await materializeModel(model, evidence, visible);
    const candidates = businessScenarios([view], task, snapshot, 400).scenarios;
    for (const item of task.acceptance_criteria.filter(item => item.business_check?.model_id === id)) {
      const scenario = candidates.find(candidate => candidate.scenario_id === item.business_check!.scenario_id && candidate.rule_id === item.business_check!.rule_id);
      if (!scenario || scenario.coverage !== "checked" || item.business_check!.rule_fingerprint !== scenario.business_check.rule_fingerprint
        || item.status !== "checked" || item.review_snapshot !== snapshot) throw new Error(`业务验收需要重新核对当前规则与依据：${item.id}`);
    }
  }
}
