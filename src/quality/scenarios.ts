import { digest } from "../knowledge/document.js";
import type { Task } from "../domain/task.js";
import type { materializeModel } from "../understanding/model-view.js";
import { ruleFingerprint } from "../understanding/model-evidence.js";

type View = Awaited<ReturnType<typeof materializeModel>>;
/** 场景绑定规则语义和实际复核的来源版本；其他规则修订不使本条验收无故失效。 */
export function businessScenarios(views: View[], task?: Task, snapshot?: string, limit = 40) {
  const scenarios = [];
  let total = 0;
  const valid = new Set<string>(), selected = new Set(views.map(view => view.id));
  for (const model of views) if (model.schema_version === 2) for (const rule of model.rules) {
    const fingerprint = digest(JSON.stringify([ruleFingerprint(rule), rule.evidence_versions]));
    const definitions = [ { kind: "normal", text: rule.conditions.join("；") },
      ...rule.conditions.map(text => ({ kind: "boundary", text })), ...rule.exceptions.map(text => ({ kind: "exception", text })) ];
    for (const definition of definitions) {
      total++;
      const scenario_id = `scenario-${digest(JSON.stringify([model.id, rule.id, definition])).slice(0, 24)}`;
      valid.add(JSON.stringify([model.id, rule.id, scenario_id]));
      if (scenarios.length >= limit) continue;
      const business_check = { model_id: model.id, rule_id: rule.id, rule_fingerprint: fingerprint, scenario_id };
      const matches = task?.acceptance_criteria.filter(item => item.business_check?.model_id === model.id
        && item.business_check.rule_id === rule.id && item.business_check.scenario_id === scenario_id) ?? [];
      const checked = matches.some(item => item.status === "checked" && item.review_snapshot === snapshot && item.business_check!.rule_fingerprint === fingerprint);
      const coverage = rule.freshness !== "current" || rule.basis === "inferred" ? "needs_rule_review"
        : checked ? "checked" : matches.some(item => item.business_check!.rule_fingerprint === fingerprint) ? "pending" : matches.length ? "stale" : "unlinked";
      scenarios.push({ scenario_id, rule_id: rule.id, business_check, model_revision: model.revision, kind: definition.kind, basis: rule.basis,
        description: `${definition.kind === "normal" ? "满足适用条件" : definition.kind === "boundary" ? "核对条件成立与不成立的边界" : "核对异常或例外"}：${definition.text.slice(0, 300)}`,
        expected_rule: rule.description.slice(0, 300), coverage, acceptance_ids: matches.map(item => item.id) });
    }
  }
  return { scenarios, total, truncated: total > scenarios.length,
    obsolete_acceptance_ids: task?.acceptance_criteria.filter(item => item.business_check && selected.has(item.business_check.model_id)
      && !valid.has(JSON.stringify([item.business_check.model_id, item.business_check.rule_id, item.business_check.scenario_id]))).map(item => item.id) ?? [],
    limitation: "场景是验证建议，边界取值与异常预期需阅读需求和源码确定。只有绑定当前规则指纹、已核验且代码快照一致的验收项才计为 checked，不代表工具已执行测试。" };
}
