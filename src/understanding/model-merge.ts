import { isDeepStrictEqual as equal } from "node:util";
import { AppError } from "../domain/error.js";
import type { ModuleSnapshot } from "../project-knowledge/view-resolver.js";
import { BusinessRelation, BusinessRuleV3, ModelPatch, SavedRuleV3, type ModernModel, type RecordRequest, type RuleV3 } from "./model-contracts.js";
import { CodeBindingInput } from "./semantic-contracts.js";

/** 沿不可变父链找唯一最近共同祖先。多个最佳祖先不能按时间或哈希任挑一个。 */
export async function commonSnapshot(ids: string[], load: (id: string) => Promise<ModuleSnapshot>): Promise<ModuleSnapshot> {
  const graph = new Map<string, ModuleSnapshot>();
  const ancestors: Set<string>[] = [];
  for (const id of ids) {
    const seen = new Set<string>(), queue = [id];
    while (queue.length) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const snapshot = graph.get(next) ?? await load(next);
      graph.set(next, snapshot);
      if (graph.size > 2048) throw new AppError("PROJECT_MODEL_MERGE_LIMIT", "快照祖先超过核验预算，请分步核对谱系");
      queue.push(...snapshot.parent_snapshot_ids);
    }
    ancestors.push(seen);
  }
  const common = [...ancestors[0]!].filter(id => ancestors.every(group => group.has(id)));
  const superseded = new Set(common.flatMap(id => graph.get(id)!.parent_snapshot_ids));
  const best = common.filter(id => !superseded.has(id));
  if (best.length !== 1) throw new AppError("PROJECT_MODEL_MERGE_BASE", "多个复核来源缺少唯一共同祖先，已保留各自快照，请先核对来源谱系");
  return graph.get(best[0]!)!;
}

/** 留给调用方显式处理同一条目的分歧。未提交选择时保留全部不可变父快照。 */
function resolveItem<T>(key: string, base: T, values: T[]): T {
  const changed = values.filter(value => !equal(value, base));
  if (changed.some(value => !equal(value, changed[0])))
    throw new AppError("PROJECT_MODEL_MERGE_CONFLICT", `工作树快照在 ${key} 上分歧，请核对各候选后在 patch 中明确选择`);
  return changed.length ? changed[0]! : base;
}

/** 计算相对于第一个父模型必须补入的变动。返回的 upsert 仍须经过 buildModel 的当前源码核验。 */
function mergeList<T>(name: string, key: (item: T) => string, base: T[], parents: T[][], explicit: Set<string>,
  decide: (name: string, original: T | undefined, values: (T | undefined)[]) => T | undefined = resolveItem) {
  const index = (items: T[]) => new Map(items.map(item => [key(item), item]));
  const original = index(base), maps = parents.map(index);
  const keys = new Set([...original.keys(), ...maps.flatMap(map => [...map.keys()])]);
  const upserts: T[] = [], removed: string[] = [];
  for (const id of keys) {
    if (explicit.has(id)) continue;
    const values = maps.map(map => map.get(id));
    const winner = decide(`${name}.${id}`, original.get(id), values);
    if (equal(winner, values[0])) continue;
    if (winner === undefined) removed.push(id); else upserts.push(winner);
  }
  return { upserts, removed };
}

/** 同条规则的条件或描述互斥时保留冲突；相同规则下独立的具名场景按 ID 逐个比较。 */
function mergeRule(name: string, original: RuleV3 | undefined, values: (RuleV3 | undefined)[]): RuleV3 | undefined {
  if (!original?.semantics || !values.every(rule => rule?.semantics))
    return resolveItem(name, original, values);
  function separate(rule: RuleV3) {
    const { semantics, ...common } = rule;
    const { cases, preserves, ...condition } = semantics!;
    return { header: { ...common, semantics: condition }, cases, preserves };
  }
  const base = separate(original), versions = values.map(item => separate(item!));
  const header = resolveItem(name + ".conditions", base.header, versions.map(item => item.header));
  function mergeScenarios<T extends { id: string }>(field: string, before: T[], branches: T[][]) {
    const byId = (items: T[]) => new Map(items.map(item => [item.id, item]));
    const prior = byId(before), maps = branches.map(byId);
    return [...new Set([...prior.keys(), ...maps.flatMap(map => [...map.keys()])])].flatMap(id => {
      const winner = resolveItem(name + "." + field + "." + id, prior.get(id), maps.map(map => map.get(id)));
      return winner ? [winner] : [];
    });
  }
  return { ...header, semantics: { ...header.semantics, cases: mergeScenarios("cases", base.cases, versions.map(item => item.cases)),
    preserves: mergeScenarios("preserves", base.preserves, versions.map(item => item.preserves)) } };
}

/** 指纹、行区间与解析状态由当前工作树重建，不把另一个工作树的验收状态带入新快照。 */
function editable(model: ModernModel) {
  const rules = model.rules.map(raw => {
    const { evidence_versions, bindings, ...rule } = SavedRuleV3.parse(raw);
    return BusinessRuleV3.parse({ ...rule, ...(bindings ? { bindings: bindings.map(item => {
      const { start, end, symbol_sha256, target_sha256, resolution, ...input } = item;
      return CodeBindingInput.parse(input);
    }) } : {}) });
  });
  const relations = model.relations.map(raw => {
    const { evidence_versions, rule_versions, target_sha256, target_model_revision, target_rule_versions, entity_versions, target_entity_versions, ...relation } = raw;
    return BusinessRelation.parse(relation);
  });
  return { ...model, rules, relations };
}

/** 将独立条目变化编译为普通 patch，从同一入口执行引用、大小、修订号和源码检查。 */
export function mergeModelPatch(request: RecordRequest, ancestor: ModernModel, parents: ModernModel[]): RecordRequest {
  if (!request.patch) throw new AppError("PROJECT_MODEL_PATCH_REQUIRED", "整合多个知识快照需要明确的模型 patch");
  const patch = { ...request.patch };
  const base = editable(ancestor), views = parents.map(editable);
  const explicit = (items?: {id: string}[], removed?: string[]) => new Set([...(items ?? []).map(item => item.id), ...removed ?? []]);
  const rules = mergeList("rules", item => item.id, base.rules, views.map(v => v.rules), explicit(patch.upsert_rules, patch.remove_rule_ids), mergeRule);
  const sources = mergeList("sources", item => item.id, base.sources, views.map(v => v.sources), explicit(patch.upsert_sources, patch.remove_source_ids));
  const relations = mergeList("relations", item => item.id, base.relations, views.map(v => v.relations), explicit(patch.upsert_relations, patch.remove_relation_ids));
  // 独立条目可以搬运，另一分支重定义同 ID 依据时必须复核，不能把旧结论绑定新引文。
  const mergedSources = new Map(views[0]!.sources.map(source => [source.id, source]));
  for (const source of [...sources.upserts, ...patch.upsert_sources ?? []]) mergedSources.set(source.id, source);
  for (const id of [...sources.removed, ...patch.remove_source_ids ?? []]) mergedSources.delete(id);
  function checkTransplantedEvidence<T extends { id: string; source_ids: string[] }>(name: string, changed: T[],
    original: T[], versions: T[][]) {
    for (const item of changed) {
      const initial = original.find(row => row.id === item.id);
      for (const [i, rows] of versions.entries()) {
        const contributing = rows.find(row => row.id === item.id);
        if (!contributing || equal(initial, contributing)) continue;
        for (const sourceId of contributing.source_ids) {
          if (!item.source_ids.includes(sourceId)) continue;
          const source = views[i]!.sources.find(row => row.id === sourceId);
          if (!equal(mergedSources.get(sourceId), source))
            throw new AppError("PROJECT_MODEL_MERGE_CONFLICT", `自动合入的 ${name}.${item.id} 使用了已变更的来源 ${sourceId}，请核对后显式提交`);
        }
      }
    }
  }
  checkTransplantedEvidence("rules", rules.upserts, base.rules, views.map(view => view.rules));
  checkTransplantedEvidence("relations", relations.upserts, base.relations, views.map(view => view.relations));
  const metadata = { ...patch.metadata };
  for (const field of ["title", "summary", "module"] as const) {
    if (metadata[field] !== undefined) continue;
    const winner = resolveItem(field, base[field], views.map(v => v[field]));
    if (winner !== views[0]![field]) metadata[field] = winner;
  }
  function mergeMetadata<T>(field: string, key: (item: T) => string, before: T[], versions: T[][], supplied?: T[]) {
    if (supplied) return supplied;
    const { upserts, removed } = mergeList(field, key, before, versions, new Set());
    const changed = new Set([...upserts.map(key), ...removed]);
    return [...versions[0]!.filter(item => !changed.has(key(item))), ...upserts];
  }
  for (const field of ["related_paths", "scope", "questions"] as const)
    metadata[field] = mergeMetadata(field, item => item, base[field], views.map(v => v[field]), metadata[field]);
  metadata.entities = mergeMetadata("entities", item => item.id ?? item.name, base.entities, views.map(v => v.entities), metadata.entities);
  metadata.flows = mergeMetadata("flows", item => item.name, base.flows, views.map(v => v.flows), metadata.flows);
  // 显式删除在首个父节点已不存在时等价于保持删除，不能由此删除一个从未存在过的 ID。
  function deletions(auto: string[], chosen: string[] | undefined, sets: {id: string}[][]) {
    return [...auto, ...(chosen ?? []).filter(id => sets[0]!.some(item => item.id === id) || !sets.some(items => items.some(item => item.id === id)))];
  }
  return { ...request, patch: ModelPatch.parse({ ...patch, metadata,
    upsert_rules: [...patch.upsert_rules ?? [], ...rules.upserts], remove_rule_ids: deletions(rules.removed, patch.remove_rule_ids, views.map(v => v.rules)),
    upsert_sources: [...patch.upsert_sources ?? [], ...sources.upserts], remove_source_ids: deletions(sources.removed, patch.remove_source_ids, views.map(v => v.sources)),
    upsert_relations: [...patch.upsert_relations ?? [], ...relations.upserts], remove_relation_ids: deletions(relations.removed, patch.remove_relation_ids, views.map(v => v.relations)),
  }) };
}
