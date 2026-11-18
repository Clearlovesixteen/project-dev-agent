import { AppError } from "../domain/error.js";
import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { SavedRuleV3 } from "../understanding/model-contracts.js";
import { dependencyFingerprint, ruleFingerprint } from "../understanding/model-evidence.js";
import { loadWorktreeModels } from "../project-knowledge/worktree-models.js";
import { behaviorFiles } from "./behavior-execution.js";
import { businessBoundary } from "./business-boundary.js";
import { businessInputsCurrent, planFingerprint } from "./business-plan.js";
import type { BusinessPlanRecord } from "./business-plan-contracts.js";
import { activeBusinessDeltas, planRule, relatedPaths, ruleKey } from "./business-plan-targets.js";
import { readValidationRun } from "./validation-store.js";
import type { validationReview } from "./validation-review.js";
import { enhancedBusinessDelta } from "./business-delta-contracts.js";

type Execution = Awaited<ReturnType<typeof validationReview>>;

/** 只接受当前计划和代码快照上，插件报告器记录的唯一命名测试通过。 */
async function behaviorReview(files: ProjectFiles, task: Task, record: BusinessPlanRecord, execution: Execution, snapshot: string) {
  const plan = task.validation_plans?.at(-1);
  const cache = new Map<string, ReturnType<typeof readValidationRun>>();
  const cases = [];
  for (const scenario of record.input.scenarios) {
    const check = plan?.plan.checks.find(item => item.id === scenario.check_id);
    const summary = execution.checks.find(item => item.id === scenario.check_id);
    let state = "missing_check";
    if (check?.behavior_report && check.acceptance_ids.includes(scenario.acceptance_id) && behaviorFiles(check).includes(scenario.test_file)) {
      state = summary?.state ?? "not_run";
      if (summary?.state === "passed" && summary.run_id) {
        let loaded = cache.get(summary.run_id);
        if (!loaded) { loaded = readValidationRun(files, task.id, summary.run_id); cache.set(summary.run_id, loaded); }
        const run = await loaded;
        const matches = run.behavior?.cases.filter(item => item.file === scenario.test_file && item.name === scenario.test_name) ?? [];
        const current = run.plan_version === plan?.version && run.start_snapshot === snapshot && run.end_snapshot === snapshot
          && run.state === "passed" && run.repo_identity === task.repo_identity && run.worktree_path === files.root;
        state = !current || !run.behavior?.complete || run.behavior.business_plan_fingerprint !== record.fingerprint ? "incomplete_report"
          : matches.length !== 1 ? matches.length ? "ambiguous_test" : "missing_test" : matches[0]!.state;
      }
    }
    cases.push({ id: scenario.id, acceptance_id: scenario.acceptance_id, test_file: scenario.test_file,
      test_name: scenario.test_name, state, ...(summary?.run_id ? { run_id: summary.run_id } : {}) });
  }
  return cases;
}

/** 已验证的模型可以回写草案。范围、来源或真实行为不通过时，关闭和模型发布共用同一门槛。 */
export async function businessPlanReview(binding: WorktreeBinding, task: Task, snapshot: string, changed: string[], execution: Execution) {
  const record = task.business_plans?.at(-1);
  const deltas = activeBusinessDeltas(task);
  const required = !!record || task.business_model_policy === 1 || deltas.some(delta => enhancedBusinessDelta(delta.input)
    || !!SavedRuleV3.safeParse(delta.before_rule).data?.semantics);
  if (!required && !task.acceptance_criteria.some(item => item.business_check)) return { state: "not_applicable" as const, required: false };
  const files = new ProjectFiles(binding.root);
  const { knowledge, models: all } = await loadWorktreeModels(binding, files);
  const enhancedAcceptance = task.acceptance_criteria.some(item => item.business_check && all.some(model => model.id === item.business_check!.model_id
    && model.schema_version === 3 && model.rules.some(rule => rule.id === item.business_check!.rule_id && !!rule.semantics)));
  if (!record) return required || enhancedAcceptance ? { state: "missing" as const, required: true } : { state: "not_applicable" as const, required: false };
  const issues: string[] = [];
  if (knowledge.state === "unavailable") issues.push("project_knowledge_unavailable");
  if (knowledge.modules?.some(item => ["ambiguous", "partial"].includes(item.state) && record.input.rules.some(rule => rule.model_id === item.model_id)))
    issues.push("project_model_review_required");
  if (record.fingerprint !== planFingerprint(record)) issues.push("plan_corrupt");
  if (!await businessInputsCurrent(binding, task, record)) issues.push("input_changed");
  if (record.input.input_items.some(item => item.kind === "unresolved")) issues.push("unresolved_requirement");
  if (deltas.some(delta => !record.input.rules.some(ref => ref.delta_id === delta.input.id))) issues.push("delta_uncovered");
  const modeled = new Set(record.targets.flatMap(target => target.bindings.map(item => item.input.path)));
  if (relatedPaths(all, record.input.rules).some(path => !modeled.has(path) && !record.input.related_checks.some(item => item.path === path))) issues.push("relation_uncovered");
  for (const ref of record.input.rules) {
    try {
      const { rule, delta, current } = planRule(all, task, ref);
      const saved = record.targets.find(item => ruleKey(item) === ruleKey(ref));
      if (!saved || saved.rule_fingerprint !== ruleFingerprint(rule) || saved.delta_fingerprint !== delta?.fingerprint
        || !delta && current && saved.dependency_fingerprint !== dependencyFingerprint(current)) issues.push(`rule_changed:${ruleKey(ref)}`);
    } catch { issues.push(`rule_unavailable:${ruleKey(ref)}`); }
  }
  const boundary = await businessBoundary(binding, task, record, changed);
  const scenarios = await behaviorReview(files, task, record, execution, snapshot);
  const passed = !issues.length && boundary.state === "checked" && scenarios.every(item => item.state === "passed");
  return { state: passed ? "checked" as const : "pending" as const, required: true, issues, boundary, scenarios,
    plan_fingerprint: record.fingerprint, input_items: record.input.input_items.map(({ id, kind, source_id, acceptance_ids }) => ({ id, kind, source_id, acceptance_ids })),
    limitation: "范围检查覆盖任务基线与已绑定代码位置。场景结果以当前快照上的命名测试为依据，断言是否完整仍需核对。" };
}

export function assertBusinessPlan(review: Awaited<ReturnType<typeof businessPlanReview>>) {
  if (!review.required || review.state === "checked") return;
  throw new AppError(review.state === "missing" ? "BUSINESS_PLAN_REQUIRED" : "BUSINESS_PLAN_INCOMPLETE",
    "先核对业务计划的原文、影响与修改范围，再执行关联的命名场景测试。详情见 task_check 的 quality.business_plan。");
}
