import { AppError } from "../domain/error.js";
import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/index.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { ProjectFiles } from "../storage/project-files.js";
import { excluded, safeSource, sourceBoundary } from "../understanding/scan.js";
import { loadWorktreeModels } from "../project-knowledge/worktree-models.js";
import { BusinessPlanInput, BusinessPlanRecord, type BusinessPlan } from "./business-plan-contracts.js";
import { activeBusinessDeltas, bindingKey, captureTargets, locationKey, planRule, relatedPaths, ruleKey } from "./business-plan-targets.js";
import { latestSources, requirementSourceText, sourceCheck } from "./requirement-review.js";
import { businessDeltaScenarios } from "./business-deltas.js";

/** 权限由开始编码前保存的计划导出，不从完成清单或事后差异反推。 */
export function modificationScope(record: BusinessPlanRecord) {
  const paths = new Map<string, Set<string> | null>();
  for (const support of record.input.supporting_changes) paths.set(support.path, null);
  for (const target of record.targets) for (const { input } of target.bindings) {
    const decision = record.input.decisions.find(item => bindingKey(item) === bindingKey({ ...target, binding_id: input.id }));
    if (decision?.action !== "modify") continue;
    if (!input.symbol) { paths.set(input.path, null); continue; }
    if (paths.get(input.path) === null) continue;
    const selectors = paths.get(input.path) ?? new Set<string>();
    selectors.add(input.symbol); paths.set(input.path, selectors);
  }
  return paths;
}

export function planFingerprint(record: Pick<BusinessPlanRecord, "input" | "targets" | "source_versions" | "related_versions" | "recorded_snapshot" | "base_snapshot_ids">) {
  return digest(JSON.stringify(["business-plan-v1", record.input, record.targets, record.source_versions, record.related_versions, record.recorded_snapshot, ...(record.base_snapshot_ids ? [record.base_snapshot_ids] : [])]));
}

async function inputVersions(binding: WorktreeBinding, task: Task, plan: BusinessPlan) {
  const sources = latestSources(task.requirement_sources ?? []);
  const verified = new Map<string, Promise<string>>();
  const versions = [];
  for (const item of plan.input_items) {
    const source = sources.find(candidate => candidate.input.id === item.source_id);
    if (!source) throw new AppError("BUSINESS_INPUT_SOURCE", `缺少需求条目来源：${item.source_id}`);
    let text = verified.get(item.source_id);
    if (!text) { text = requirementSourceText(binding, task, source); verified.set(item.source_id, text); }
    if (!(await text).includes(item.quote)) throw new AppError("BUSINESS_INPUT_QUOTE", `需求条目原文不匹配：${item.id}`);
    if (item.acceptance_ids.some(id => !task.acceptance_criteria.some(check => check.id === id && sourceCheck(check).source_ids.includes(item.source_id))))
      throw new AppError("BUSINESS_INPUT_ACCEPTANCE", `验收项须引用相同需求来源：${item.id}`);
    if ((item.kind === "behavior" || item.kind === "constraint") && !plan.scenarios.some(scenario => item.acceptance_ids.includes(scenario.acceptance_id)))
      throw new AppError("BUSINESS_INPUT_SCENARIO", `业务要求或约束需要对应行为测试：${item.id}`);
    versions.push({ id: item.id, fingerprint: source.fingerprint });
  }
  if (task.spec_input?.source_ids.some(id => !plan.input_items.some(item => item.source_id === id)))
    throw new AppError("BUSINESS_INPUT_SPEC_COVERAGE", "每份有效 PRD/SDD 来源应有本次采用、约束或待确认的原文条目");
  return versions;
}

export async function businessInputsCurrent(binding: WorktreeBinding, task: Task, record: BusinessPlanRecord): Promise<boolean> {
  try { return JSON.stringify(await inputVersions(binding, task, record.input)) === JSON.stringify(record.source_versions); }
  catch { return false; }
}

/** 开工前固定业务条目、实际位置与允许修改范围。修改之后只允许在未改路径上扩大范围。 */
export async function recordBusinessPlan(binding: WorktreeBinding, task: Task, value: unknown, snapshot: Awaited<ReturnType<typeof reviewSnapshot>>) {
  const plan = BusinessPlanInput.parse(value), previous = task.business_plans?.at(-1);
  if (!previous && snapshot.paths.length) throw new AppError("BUSINESS_PLAN_LATE", "增强业务计划应在本轮修改之前保存；已有用户改动以任务接入时的基线为准");
  const acceptanceIds = new Set(task.acceptance_criteria.map(item => item.id));
  if ([...plan.decisions, ...plan.related_checks, ...plan.supporting_changes].some(item => item.acceptance_ids.some(id => !acceptanceIds.has(id))))
    throw new AppError("BUSINESS_PLAN_ACCEPTANCE", "范围决定须关联本任务的验收项");
  const source_versions = await inputVersions(binding, task, plan);
  const files = new ProjectFiles(binding.root);
  const focusedRules = new Set(plan.rules.map(ruleKey));
  const { config, knowledge, snapshotIds, models: all } = await loadWorktreeModels(binding, files, focusedRules);
  const referencedModels = new Set(plan.rules.map(rule => rule.model_id));
  const newModelIds = new Set(activeBusinessDeltas(task).filter(delta => !!delta.input.new_model).map(delta => delta.input.model_id));
  const existingModelIds = new Set([...referencedModels].filter(id => !newModelIds.has(id)));
  if ([...existingModelIds].some(id => !snapshotIds.has(id)))
    throw new AppError("PROJECT_MODEL_REVIEW_REQUIRED", "本次业务计划引用的模型尚未完成当前源码核验，请先复核来源、冲突和覆盖范围");
  if (knowledge.rule_reviews?.items.some(item => focusedRules.has(`${item.model_id}/${item.rule_id}`)))
    throw new AppError("PROJECT_MODEL_REVIEW_REQUIRED", "本次业务计划引用的规则存在来源或绑定复核项，请先处理后再登记计划");
  const targets = await captureTargets(binding, task, plan, all);
  const byBinding = new Map(targets.flatMap(target => target.bindings.map(bound => [bindingKey({ ...target, binding_id: bound.input.id }), bound.input] as const)));
  const decisions = new Map(plan.decisions.map(item => [bindingKey(item), item]));
  if (decisions.size !== plan.decisions.length || [...decisions.keys()].some(key => !byBinding.has(key)))
    throw new AppError("BUSINESS_PLAN_DECISION", "每个代码绑定须有一项明确决定，不能指定不存在的绑定");
  if (activeBusinessDeltas(task).some(delta => !plan.rules.some(ref => ref.delta_id === delta.input.id)))
    throw new AppError("BUSINESS_PLAN_DELTA", "计划须覆盖任务当前的业务草案");
  const modeledPaths = new Set([...byBinding.values()].map(item => item.path));
  const related = relatedPaths(all, plan.rules);
  if (related.some(path => !modeledPaths.has(path) && !plan.related_checks.some(item => item.path === path)))
    throw new AppError("BUSINESS_PLAN_RELATION_REQUIRED", "已建模的上下游入口须有核对决定，或先建立其代码绑定");
  const protectedPaths = new Set([...modeledPaths, ...related, ...plan.related_checks.map(item => item.path)]);
  for (const model of all) if (model.schema_version === 3) for (const rule of model.rules) {
    for (const binding of rule.bindings ?? []) protectedPaths.add(binding.path);
  }
  if (plan.supporting_changes.some(item => protectedPaths.has(item.path)))
    throw new AppError("BUSINESS_PLAN_SHARED_SCOPE", "已建模和待核对的路径不能通过辅助修改取得整文件权限");
  const locations = new Map<string, string>();
  for (const [key, item] of decisions) {
    const location = locationKey(byBinding.get(key)!);
    const prior = locations.get(location);
    if (prior && (prior === "modify") !== (item.action === "modify"))
      throw new AppError("BUSINESS_PLAN_SCOPE_CONFLICT", "同一代码位置的修改和保护决定冲突，请收窄修改范围");
    locations.set(location, item.action);
  }
  const scenarios = new Set<string>(), tests = new Set<string>();
  for (const scenario of plan.scenarios) {
    const ref = plan.rules.find(item => ruleKey(item) === ruleKey(scenario));
    if (!ref || !acceptanceIds.has(scenario.acceptance_id) || !plan.input_items.some(item => item.acceptance_ids.includes(scenario.acceptance_id)))
      throw new AppError("BUSINESS_PLAN_SCENARIO", "场景须指向本计划规则和有需求来源的验收项");
    const { rule, delta } = planRule(all, task, ref);
    if (scenario.case_id ? !rule.semantics.cases.some(item => item.id === scenario.case_id) : !rule.semantics.preserves.some(item => item.id === scenario.preserve_id))
      throw new AppError("BUSINESS_PLAN_SCENARIO", "场景引用了不存在的条件样例或保留行为");
    if (delta && delta.input.operation !== "remove") {
      const expected = businessDeltaScenarios(delta).find(item => item.case_id === scenario.case_id && item.preserve_id === scenario.preserve_id);
      const criterion = task.acceptance_criteria.find(item => item.id === scenario.acceptance_id);
      if (!expected || !delta.input.acceptance_ids.includes(scenario.acceptance_id)
        || JSON.stringify(criterion?.business_delta_check) !== JSON.stringify(expected.business_delta_check))
        throw new AppError("BUSINESS_PLAN_SCENARIO", "草案的命名测试须关联同一个草案场景验收");
    }
    const key = `${ruleKey(scenario)}/${scenario.case_id ? `case/${scenario.case_id}` : `preserve/${scenario.preserve_id}`}`;
    const test = JSON.stringify([scenario.test_file, scenario.test_name]);
    if (scenarios.has(key) || tests.has(test)) throw new AppError("BUSINESS_PLAN_SCENARIO", "每个业务场景需绑定唯一的命名测试");
    scenarios.add(key); tests.add(test);
  }
  for (const ref of plan.rules) {
    const { rule } = planRule(all, task, ref);
    if (!rule.semantics.cases.some(item => item.expected === "allowed") || !rule.semantics.cases.some(item => item.expected === "denied")
      || rule.semantics.cases.some(item => !scenarios.has(`${ruleKey(ref)}/case/${item.id}`))
      || rule.semantics.preserves.some(item => !scenarios.has(`${ruleKey(ref)}/preserve/${item.id}`)))
      throw new AppError("BUSINESS_PLAN_SCENARIO_COVERAGE", "每条规则至少有允许与拒绝场景，其余已声明样例和保留行为均需绑定测试");
  }
  const related_versions = [];
  for (const item of plan.related_checks) {
    if (item.action === "not_applicable") continue;
    try {
      const original = previous?.related_versions.find(value => value.path === item.path);
      if (!original && snapshot.paths.includes(item.path)) throw new Error("关联文件已修改");
      related_versions.push(original ?? { path: item.path, sha256: digest(await safeSource(files, item.path, config)) });
    } catch { throw new AppError("BUSINESS_PLAN_RELATION_UNRESOLVED", `关联核对位置需要真实的只读文件：${item.path}`); }
  }
  const base_snapshot_ids = [...existingModelIds].sort().map(model_id => ({ model_id, snapshot_id: snapshotIds.get(model_id)! }));
  const inputs = { input: plan, targets, base_snapshot_ids, source_versions, related_versions, recorded_snapshot: snapshot.hash };
  const record = BusinessPlanRecord.parse({ ...inputs, fingerprint: "0".repeat(64), recorded_at: new Date().toISOString() });
  record.fingerprint = planFingerprint(record);
  const nextScope = modificationScope(record), priorScope = previous ? modificationScope(previous) : new Map<string, Set<string> | null>();
  for (const path of new Set([...nextScope.keys(), ...plan.related_checks.map(item => item.path), ...plan.scenarios.map(item => item.test_file)])) {
    if (excluded(path, config)) throw new AppError("BUSINESS_PLAN_SCOPE", `路径已排除：${path}`);
    await files.path(path, true);
    await sourceBoundary(files, path, config);
  }
  for (const [path, selectors] of nextScope) {
    if (task.scope_paths?.length && !task.scope_paths.some(scope => path === scope || path.startsWith(`${scope}/`)))
      throw new AppError("BUSINESS_PLAN_SCOPE", `修改位置超出任务范围：${path}`);
    if (!snapshot.paths.includes(path)) continue;
    const old = priorScope.get(path);
    if (old !== null && (selectors === null || !old || [...selectors].some(symbol => !old.has(symbol))))
      throw new AppError("BUSINESS_PLAN_RETROACTIVE_SCOPE", `已修改路径不能事后取得更大的修改范围：${path}`);
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 96_000) throw new AppError("BUSINESS_PLAN_LIMIT", "业务计划过大，请缩小本次业务范围");
  if ((await reviewSnapshot(binding, task.baseline_head, task.workspace_baseline)).hash !== snapshot.hash)
    throw new AppError("REVIEW_SNAPSHOT_CHANGED", "建立业务计划期间代码变化，请重新核对");
  return record;
}
