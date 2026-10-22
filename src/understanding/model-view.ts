import { AppError } from "../domain/error.js";
import { ModelEvidence, ruleFingerprint, sourceFingerprint } from "./model-evidence.js";
import type { SavedModel } from "./model-contracts.js";

/** 逐条检查规则与关系；整个模型过期并不代表其中每条规则都需要重新分析。 */
export async function materializeModel(model: SavedModel, evidence: ModelEvidence, visible: SavedModel[]) {
  const source_states = [];
  for (const source of model.related_versions) source_states.push({ path: source.path, state: await evidence.pathState(source.path, source.sha256) });
  const stalePaths = source_states.filter((item) => item.state !== "current").map((item) => item.path);
  if (model.schema_version === 1) return { ...model, status: stalePaths.length ? "needs_review" : "candidate", effective: false as const,
    source_states, model_capabilities: "legacy", migration_required: false };
  const sourceMap = new Map(model.sources.map((source) => [source.id, source]));
  const evidence_states = [];
  for (const source of model.sources) evidence_states.push({ id: source.id, state: await evidence.sourceState(source) });
  const stateMap = new Map(evidence_states.map((item) => [item.id, item.state]));
  const reasons = (item: { source_ids: string[]; evidence_versions: { id: string; fingerprint: string }[] }) => item.source_ids.flatMap((id) => {
    const source = sourceMap.get(id), version = item.evidence_versions.find((entry) => entry.id === id);
    if (!source || !version || sourceFingerprint(source) !== version.fingerprint) return [{ source_id: id, state: "evidence_revised" }];
    return stateMap.get(id) === "current" ? [] : [{ source_id: id, state: stateMap.get(id) ?? "missing" }];
  });
  const rules = model.rules.map((rule) => {
    const review_reasons = reasons(rule);
    return { ...rule, freshness: review_reasons.length ? "needs_review" : "current", review_reasons };
  });
  const relations = [];
  for (const relation of model.relations) {
    const review_reasons: { source_id?: string; rule_id?: string; state: string }[] = reasons(relation);
    for (const id of relation.rule_ids) {
      const rule = rules.find((item) => item.id === id), version = relation.rule_versions.find((item) => item.id === id);
      if (!rule || !version || version.fingerprint !== ruleFingerprint(rule) || rule.freshness !== "current") review_reasons.push({ rule_id: id, state: "rule_needs_review" });
    }
    if (await evidence.pathState(relation.target_path, relation.target_sha256) !== "current") review_reasons.push({ state: "target_changed" });
    if (relation.target_model_id) {
      const target = visible.find((item) => item.id === relation.target_model_id);
      if (!target) review_reasons.push({ state: "target_model_missing_or_excluded" });
      else if (target.revision !== relation.target_model_revision) review_reasons.push({ state: "target_model_revised" });
      else {
        // 只检查一层目标的原始依据，避免循环关系递归展开；不宣称覆盖跨系统调用图。
        const targetStates = await Promise.all(target.related_versions.map((item) => evidence.pathState(item.path, item.sha256)));
        const sourceStates = await Promise.all(target.sources.map((item) => evidence.sourceState(item)));
        const staleRules = target.schema_version === 2 && target.rules.some((rule) => rule.source_ids.some((id) => {
          const source = target.sources.find((item) => item.id === id);
          return !source || rule.evidence_versions.find((item) => item.id === id)?.fingerprint !== sourceFingerprint(source);
        }));
        if (staleRules || [...targetStates, ...sourceStates].some((state) => state !== "current")) review_reasons.push({ state: "target_model_needs_review" });
      }
    }
    relations.push({ ...relation, freshness: review_reasons.length ? "needs_review" : "current", review_reasons });
  }
  const review_required = { rule_ids: rules.filter((item) => item.freshness !== "current").map((item) => item.id),
    relation_ids: relations.filter((item) => item.freshness !== "current").map((item) => item.id), paths: stalePaths };
  const stale = Object.values(review_required).some((items) => items.length) || evidence_states.some((item) => item.state !== "current");
  return { ...model, rules, relations, evidence_states, source_states, review_required,
    status: stale ? "needs_review" : "candidate", effective: false as const, model_capabilities: "rule_evidence_and_relations" };
}

/** 详情可按稳定规则 ID 裁剪；异常条件、关系与引用一起返回，不把摘要冒充完整模型。 */
export function selectModelRules(model: Awaited<ReturnType<typeof materializeModel>>, ids: string[] | undefined) {
  if (!ids) return { ...model, content_truncated: false };
  if (model.schema_version !== 2) throw new AppError("PROJECT_MODEL_MIGRATION_REQUIRED", "旧模型没有稳定规则 ID，请先读取完整详情");
  if (ids.some((id) => !model.rules.some((rule) => rule.id === id))) throw new AppError("PROJECT_MODEL_RULE_NOT_FOUND", "规则 ID 不存在，请读取最新模型摘要");
  const rules = model.rules.filter((rule) => ids.includes(rule.id));
  const relations = model.relations.filter((relation) => relation.rule_ids.some((id) => ids.includes(id)));
  const referenced = new Set([...rules.flatMap((rule) => rule.source_ids), ...relations.flatMap((relation) => relation.source_ids)]);
  return { ...model, rules, relations, sources: model.sources.filter((source) => referenced.has(source.id)),
    content_truncated: true, selected_rule_ids: ids, total_rule_count: model.rules.length,
    details_request: { model_id: model.id, model_revision: model.revision } };
}

/** 默认只给有限摘要；规则的条件、异常和依据通过详情按需获取。 */
export function modelPreview(model: Awaited<ReturnType<typeof materializeModel>>, query: string, paths: string[]) {
  const base = { id: model.id, revision: model.revision, schema_version: model.schema_version, module: model.module, title: model.title,
    summary: model.summary.slice(0, 200), status: model.status, effective: false, content_truncated: true,
    related_path_count: model.related_paths.length, details_request: { model_id: model.id, model_revision: model.revision } };
  if (model.schema_version !== 2) return base;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const intersects = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  const matched = new Set(model.relations.filter((item) => paths.some((path) => intersects(path, item.target_path))).flatMap((item) => item.rule_ids));
  const ranked = model.rules.map((rule) => ({ rule, score: (matched.has(rule.id) ? 10 : 0) + terms.filter((term) => JSON.stringify(rule).toLowerCase().includes(term)).length }))
    .sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
  const required = model.review_required;
  const preview = { ...base, rule_count: model.rules.length, relation_count: model.relations.length, question_count: model.questions.length,
    review_required: { rule_ids: required.rule_ids.slice(0, 5), relation_ids: required.relation_ids.slice(0, 5),
      rule_count: required.rule_ids.length, relation_count: required.relation_ids.length, path_count: required.paths.length },
    rules: ranked.slice(0, 3).map(({ rule }) => ({ id: rule.id, basis: rule.basis, description: rule.description.slice(0, 160), freshness: rule.freshness })),
    related_model_ids: [...new Set(model.relations.flatMap((relation) => relation.target_model_id ? [relation.target_model_id] : []))].slice(0, 5) };
  while (Buffer.byteLength(JSON.stringify(preview)) > 4_096 && preview.rules.length) preview.rules.pop();
  for (const list of [preview.related_model_ids, preview.review_required.relation_ids, preview.review_required.rule_ids]) {
    while (Buffer.byteLength(JSON.stringify(preview)) > 4_096 && list.length) list.pop();
  }
  return preview;
}

/** 在直接命中之外展开一层显式业务关系，支持无代码 import 的跨模块关联。 */
export function relatedModelIds(models: SavedModel[], seedIds: Set<string>): Set<string> {
  const related = new Set<string>();
  for (const model of models) if (model.schema_version === 2) for (const relation of model.relations) {
    if (!relation.target_model_id) continue;
    if (seedIds.has(model.id)) related.add(relation.target_model_id);
    if (seedIds.has(relation.target_model_id)) related.add(model.id);
  }
  return related;
}
