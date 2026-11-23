import { TaskStore } from "../storage/task-store.js";
import { assertBaseline, bindWorktree } from "../git/baseline.js";
import { assertTaskOwner, currentInteraction } from "../workflow/interaction.js";
import { businessPlanIssues } from "../quality/business-plan-review.js";
import { bindingKey } from "../quality/business-plan-targets.js";
import type { ProjectKnowledgeStatus } from "../project-knowledge/service.js";
import type { SavedModel } from "../understanding/model-contracts.js";
import type { ModelEvidence } from "../understanding/model-evidence.js";
import type { ImplementationView } from "./implementation-view.js";

/** 仅在显式指定本轮任务时读取计划。来源、归属或范围不再可靠时只返回缺口，绝不扩大修改授权。 */
export async function addTaskLocations(view: ImplementationView, root: string, taskId: string, models: SavedModel[],
  knowledge: ProjectKnowledgeStatus | undefined, evidence: ModelEvidence, visible: (path: string) => boolean) {
  if (!currentInteraction()) { view.gap("task_session_required"); return; }
  const task = await new TaskStore(root).load(taskId);
  if (!task.owner || task.phase !== "active") { view.gap("active_owned_task_required"); return; }
  assertTaskOwner(task);
  const binding = await bindWorktree(root);
  await assertBaseline(binding, task);
  view.setInputKind(task.spec_input?.kind);
  const plan = task.business_plans?.at(-1);
  if (!plan) { view.gap("business_plan_missing"); return; }
  if (!knowledge || knowledge.state === "unavailable" || knowledge.state === "unverified" || knowledge.state === "needs_review" && !knowledge.modules) { view.gap("model_view_needs_review"); return; }
  const issues = await businessPlanIssues(binding, task, plan, knowledge, models);
  for (const issue of issues) view.gap(issue);
  if (issues.length) return;
  const decisions = new Map(plan.input.decisions.map(item => [bindingKey(item), item]));
  for (const target of plan.targets) for (const { input, initial } of target.bindings) {
    if (!visible(input.path)) continue;
    const decision = decisions.get(bindingKey({ ...target, binding_id: input.id }));
    if (!decision || decision.action === "not_applicable") continue;
    const state = await evidence.bindingState(initial);
    const current = state === "current" || state === "planned" && initial.resolution === "planned" && input.planned;
    if (!current) view.gap("plan_binding_needs_review");
    view.add(current ? decision.action : "inspect", { path: input.path, symbol: input.symbol, model_id: target.model_id,
      rule_id: target.rule_id, binding_id: input.id, reason: current ? "registered_plan" : "plan_binding_needs_review",
      acceptance_id: decision.acceptance_ids[0] });
  }
  // 关联检查依赖自己的文件快照；未定位到规则符号的辅助文件仍要先读。
  for (const related of plan.input.related_checks) {
    if (!visible(related.path) || related.action === "not_applicable") continue;
    const saved = plan.related_versions.find(item => item.path === related.path);
    const current = saved && await evidence.pathState(related.path, saved.sha256) === "current";
    if (!current) view.gap("related_file_needs_review");
    view.add(current ? related.action : "inspect", { path: related.path, reason: current ? "registered_relation" : "related_file_needs_review",
      acceptance_id: related.acceptance_ids[0] });
  }
  for (const support of plan.input.supporting_changes) if (visible(support.path))
    view.add("inspect", { path: support.path, reason: "planned_supporting_change", acceptance_id: support.acceptance_ids[0] });
  for (const scenario of plan.input.scenarios) if (visible(scenario.test_file))
    view.add("verify", { path: scenario.test_file, symbol: scenario.test_name, check_id: scenario.check_id,
      acceptance_id: scenario.acceptance_id, rule_id: scenario.rule_id, model_id: scenario.model_id, reason: "named_test_to_run" });
}
