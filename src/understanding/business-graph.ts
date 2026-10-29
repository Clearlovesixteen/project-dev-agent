import type { SavedModel } from "./model-contracts.js";

/** 每次从权威模型记录重建双向邻接索引；不维护容易失步的第二份图数据库。 */
export function businessGraph(models: SavedModel[], seeds: Set<string>, depth = 1, budget = 30) {
  const byId = new Map(models.map(model => [model.id, model]));
  const edges = models.flatMap(model => model.schema_version === 2 ? model.relations.flatMap(relation => {
    if (!relation.target_model_id || !byId.has(relation.target_model_id)) return [];
    return [{ from_model: model.id, to_model: relation.target_model_id, relation_id: relation.id,
      kind: relation.kind, rule_ids: relation.rule_ids, target_rule_ids: relation.target_rule_ids ?? [],
      entity_ids: relation.entity_ids ?? [], target_entity_ids: relation.target_entity_ids ?? [],
      source_ids: relation.source_ids, target_path: relation.target_path,
      evidence_state: "requires_detail_check" as const }];
  }) : []).sort((a, b) => `${a.from_model}:${a.relation_id}`.localeCompare(`${b.from_model}:${b.relation_id}`));
  const adjacency = new Map<string, typeof edges>();
  for (const edge of edges) for (const id of [edge.from_model, edge.to_model]) {
    const list = adjacency.get(id) ?? []; list.push(edge); adjacency.set(id, list);
  }
  const seedIds = [...seeds].filter(id => byId.has(id));
  const visited = new Set(seedIds.slice(0, 20)), selected = new Map<string, typeof edges[number]>();
  let frontier = [...visited], truncated = seedIds.length > 20;
  for (let level = 0; level < Math.min(2, Math.max(1, depth)) && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) for (const edge of adjacency.get(id) ?? []) {
      const key = `${edge.from_model}:${edge.relation_id}`;
      if (selected.has(key)) continue;
      if (selected.size >= budget || visited.size >= 20 && (!visited.has(edge.from_model) || !visited.has(edge.to_model))) { truncated = true; continue; }
      selected.set(key, edge);
      for (const target of [edge.from_model, edge.to_model]) if (!visited.has(target)) { visited.add(target); next.push(target); }
    }
    frontier = next;
  }
  const beyondDepth = frontier.some(id => (adjacency.get(id) ?? []).some(edge => !selected.has(`${edge.from_model}:${edge.relation_id}`)));
  return { nodes: [...visited].map(id => { const model = byId.get(id)!; return { id, revision: model.revision, title: model.title,
    entities: model.entities.filter(entity => entity.id).map(entity => ({ id: entity.id, name: entity.name, aliases: entity.aliases ?? [] })) }; }),
    edges: [...selected.values()], depth: Math.min(2, Math.max(1, depth)), truncated: truncated || beyondDepth,
    limitation: "关系由来源支持的模型声明构成，仅用于发现上下游影响；需读取规则详情并核对当前证据，不能据关系存在判定必须修改。" };
}
