import { posix } from "node:path";
import type { MapFile, SavedModel } from "../understanding/contracts.js";
import { relatedModelIds } from "../understanding/model-view.js";
const intersects = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** 以修改前的计划路径和修改后的真实路径共同分析；所有结果是核对线索，不能直接算作必须修改。 */
export function impactCandidates(entries: MapFile[], models: SavedModel[], paths: string[], covered: Set<string> = new Set(), limit = 30) {
  const indexed = new Set(entries.map(entry => entry.path));
  const seeds = entries.filter(entry => paths.some(path => intersects(path, entry.path)));
  const seedPaths = new Set(seeds.map(entry => entry.path));
  const candidates = new Map<string, { path: string; reasons: string[]; model_ids: string[]; score: number }>();
  const add = (path: string, reason: string, score: number, modelId?: string) => {
    if (seedPaths.has(path) || !indexed.has(path)) return;
    const candidate = candidates.get(path) ?? { path, reasons: [], model_ids: [], score: 0 };
    if (!candidate.reasons.includes(reason)) { candidate.reasons.push(reason); candidate.score += score; }
    if (modelId && !candidate.model_ids.includes(modelId)) candidate.model_ids.push(modelId);
    candidates.set(path, candidate);
  };
  const withoutExtension = (path: string) => path.replace(/\.(?:[cm]?[jt]sx?|vue|svelte|json)$/, "").replace(/\/index$/, "");
  const requestedFiles = new Set(paths.map(withoutExtension));
  const imported = new Set(seeds.flatMap(entry => entry.imports.flatMap(item => item.target ? [item.target] : [])));
  const symbols = new Set(seeds.flatMap(entry => entry.symbols ?? []));
  const uses = new Set(seeds.flatMap(entry => entry.identifiers ?? []));
  for (const entry of entries) {
    if (imported.has(entry.path)) add(entry.path, "direct_import", 3);
    if (entry.imports.some(item => item.target && seedPaths.has(item.target))) add(entry.path, "direct_consumer", 4);
    if (entry.imports.some(item => !item.target && item.specifier.startsWith(".")
      && requestedFiles.has(withoutExtension(posix.normalize(posix.join(posix.dirname(entry.path), item.specifier)))))) add(entry.path, "unresolved_import_to_changed_path", 4);
    if ((entry.identifiers ?? []).some(name => symbols.has(name)) || (entry.symbols ?? []).some(name => uses.has(name))) add(entry.path, "shared_identifier", 1);
  }
  const direct = models.filter(model => [...model.scope, ...model.related_paths].some(path => paths.some(seed => intersects(path, seed))));
  const related = relatedModelIds(models, new Set(direct.map(model => model.id)));
  for (const model of models.filter(model => direct.includes(model) || related.has(model.id))) {
    for (const path of model.related_paths) add(path, "business_model", 3, model.id);
    if (model.schema_version === 2) for (const relation of model.relations) add(relation.target_path, `business_${relation.kind}`, 5, model.id);
  }
  const ordered = [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { candidates: ordered.slice(0, limit).map(({ score, ...item }) => ({ ...item, in_checklist: covered.has(item.path) })),
    total: ordered.length, truncated: ordered.length > limit || seeds.some(entry => entry.imports_truncated || entry.identifiers_truncated),
    seed_count: seeds.length, limitation: "引用、同名标识符和业务关系只是相关线索。请阅读实际实现，决定修改、验证或说明不适用；静态索引不能覆盖全部动态关系。" };
}
