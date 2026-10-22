import { digest } from "../knowledge/document.js";
import type { SavedModel, RuleV2 } from "./model-contracts.js";

/** 只归一化格式差异，不把近义词或不同业务条件自动视为同义。 */
export const normalizeTerm = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ");
const intersects = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
type RuleEntry = { model: SavedModel; rule: RuleV2 };
const ref = ({ model, rule }: RuleEntry) => ({ model_id: model.id, model_revision: model.revision, rule_id: rule.id,
  basis: rule.basis, source_ids: rule.source_ids, details_request: { model_id: model.id, model_revision: model.revision, rule_ids: [rule.id] } });
const conditions = (rule: RuleV2) => JSON.stringify([rule.responsibility,
  [...new Set(rule.conditions.map(normalizeTerm))].sort(), [...new Set(rule.exceptions.map(normalizeTerm))].sort()]);
const overlapping = (a: SavedModel, b: SavedModel) => a.scope.some(path => b.scope.some(other => intersects(path, other)))
  || a.related_paths.some(path => b.related_paths.includes(path));

/** 冲突与合并均是复核建议：结构化断言由 Agent 从依据中提炼，服务不能证明自然语言语义。 */
export function auditModels(models: SavedModel[], selected: Set<string>) {
  const groups = new Map<string, RuleEntry[]>();
  let withAssertion = 0, ruleCount = 0;
  for (const model of models) if (model.schema_version === 2) for (const rule of model.rules) {
    ruleCount++; if (rule.assertion) withAssertion++;
    const key = rule.assertion ? JSON.stringify([normalizeTerm(rule.assertion.subject), normalizeTerm(rule.assertion.property), conditions(rule)])
      : JSON.stringify(["text", normalizeTerm(rule.description), conditions(rule)]);
    const group = groups.get(key) ?? []; group.push({ model, rule }); groups.set(key, group);
  }
  const findings: { id: string; kind: string; refs: ReturnType<typeof ref>[]; summary: string; canonical?: ReturnType<typeof ref> }[] = [];
  let comparisons = 0, truncated = false;
  outer: for (const entries of groups.values()) for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    if (++comparisons > 20_000 || findings.length >= 200) { truncated = true; break outer; }
    const first = entries[a]!, second = entries[b]!;
    if ((!selected.has(first.model.id) && !selected.has(second.model.id)) || !overlapping(first.model, second.model)) continue;
    const valuesDiffer = first.rule.assertion && second.rule.assertion && normalizeTerm(first.rule.assertion.value) !== normalizeTerm(second.rule.assertion.value);
    const kind = valuesDiffer ? first.rule.basis === second.rule.basis ? "rule_conflict" : "behavior_divergence" : "duplicate_rule";
    // 相同断言但描述不同可能携带额外语义，不建议直接归并。
    if (!valuesDiffer && (first.rule.basis !== second.rule.basis || normalizeTerm(first.rule.description) !== normalizeTerm(second.rule.description))) continue;
    const refs = [ref(first), ref(second)].sort((a, b) => `${a.model_id}/${a.rule_id}`.localeCompare(`${b.model_id}/${b.rule_id}`));
    findings.push({ id: digest(JSON.stringify([kind, refs])).slice(0, 24), kind, refs,
      summary: valuesDiffer ? `同一对象、属性和条件记录了不同取值：${first.rule.assertion!.value.slice(0, 100)} / ${second.rule.assertion!.value.slice(0, 100)}。核对来源与当前需求。`
        : "规则文本及条件一致。核对是否可复用同一公共模型；保留各处来源，不能只凭文本相同删除规则。",
      ...(!valuesDiffer ? { canonical: refs[0]! } : {}) });
  }
  const terms = new Map<string, { model: SavedModel; meaning: string }[]>();
  for (const model of models) for (const entity of model.entities) {
    const key = normalizeTerm(entity.name), entries = terms.get(key) ?? [];
    entries.push({ model, meaning: entity.meaning }); terms.set(key, entries);
  }
  for (const [term, entries] of terms) {
    if (findings.length >= 200) { truncated = true; break; }
    const first = entries.find(entry => selected.has(entry.model.id)); if (!first) continue;
    const other = entries.find(entry => entry !== first && overlapping(first.model, entry.model) && normalizeTerm(entry.meaning) !== normalizeTerm(first.meaning));
    if (other) findings.push({ id: digest(JSON.stringify([term, first.model.id, other.model.id])).slice(0, 24), kind: "terminology_collision", refs: [],
      summary: `术语“${term.slice(0, 80)}”在 ${first.model.id} 与 ${other.model.id} 中解释不同，核对业务范围后再统一。` });
  }
  const priority = (kind: string) => kind === "duplicate_rule" ? 1 : 0;
  findings.sort((a, b) => priority(a.kind) - priority(b.kind) || a.id.localeCompare(b.id));
  const visible = findings.slice(0, 12);
  while (Buffer.byteLength(JSON.stringify(visible)) > 10_000) visible.pop();
  return { effective: false, requires_semantic_review: true, findings: visible, truncated: truncated || visible.length < findings.length,
    rule_count: ruleCount, assertion_rule_count: withAssertion,
    limitation: "只比较范围重叠且条件、异常、职责一致的结构化断言与明确重复文本。未提供断言的矛盾、近义词及隐藏业务需阅读来源核对；不自动选择正确规则或删除模型。" };
}
