import { implementationContext } from "../quality/implementation-context.js";
import { ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { loadConfig } from "../knowledge/config.js";
import { gitLine, readGit } from "../git/command.js";
import { bindWorktree } from "../git/baseline.js";
import { ContextInput, type MapFile } from "./contracts.js";
import { mapFiles, readMap } from "./store.js";
import { excluded, mapConfigHash, safeSource } from "./scan.js";
import { AppError } from "../domain/error.js";
import { ModelEvidence, sourcePath } from "./model-evidence.js";
import { businessScenarios } from "../quality/scenarios.js";
import { impactCandidates } from "../quality/impact.js";
import { auditModels } from "./model-audit.js";
import { materializeModel, modelPreview, selectModelRules } from "./model-view.js";
import { queryRanking } from "./retrieval.js";
import { businessGraph } from "./business-graph.js";
import { codeLocations } from "./code-locations.js";
import { readModelSnapshot, type ProjectKnowledgeStatus } from "../project-knowledge/service.js";
import { modelVisible, readWorktreeModels, worktreeModel } from "../project-knowledge/worktree-models.js";

export function intersects(a: string, b: string): boolean { return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); }
export function moduleSummary(entries: MapFile[]) {
  const groups = new Map<string, { module: string; files: number; roles: Record<string, number>; examples: string[] }>();
  for (const entry of entries) {
    const group = groups.get(entry.module) ?? { module: entry.module, files: 0, roles: {}, examples: [] };
    group.files++; group.roles[entry.role] = (group.roles[entry.role] ?? 0) + 1;
    if (group.examples.length < 3) group.examples.push(entry.path);
    groups.set(entry.module, group);
  }
  return [...groups.values()].sort((a, b) => a.module.localeCompare(b.module));
}
export async function projectContext(files: ProjectFiles, input: unknown, knowledge?: ProjectKnowledgeStatus) {
  const request = ContextInput.parse(input), map = await readMap(files);
  if (!map) return { state: "not_scanned", files: [], models: [], modules: [], next_step: "请运行 project_scan 建立本地项目结构索引。" };
  const { config } = await loadConfig(files);
  const paths = request.paths.filter((path) => !excluded(path, config));
  if (request.paths.length && !paths.length) return { state: "paths_excluded", files: [], models: [], modules: [] };
  const entries = (await mapFiles(files, map)).filter((entry) => !excluded(entry.path, config));
  if (request.code_locations) {
    const stale = gitLine((await readGit(files.root, ["rev-parse", "HEAD"])).stdout) !== map.head || await mapConfigHash(files, config) !== map.config_hash;
    const locations = stale ? [] : await codeLocations(files, config, entries, request.code_locations);
    return { state: stale || locations.some(item => item.state === "stale") ? "needs_rescan" : locations.every(item => item.state === "resolved") ? "indexed" : "partial",
      files: [], models: [], modules: [], code_locations: locations,
      limitation: "仅在当前结构快照内追踪显式导入和重导出。动态引用、通配重导出、歧义及未索引内容保留待核对。" };
  }
  const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(request.query.toLowerCase())].filter((term) => term.isWordLike).map((term) => term.segment).slice(0, 50);
  const score = (text: string) => terms.filter((term) => text.toLowerCase().includes(term)).length;
  const ranking = queryRanking(request.query, map);
  const matched = entries.filter((entry) => (!paths.length || paths.some((path) => intersects(path, entry.path))) && (!request.modules.length || request.modules.includes(entry.module)))
    .map((entry) => ({ entry, score: ranking.rank(entry, request.query).score }))
    .filter((entry) => !terms.length || paths.length || request.modules.length || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  const selected = matched.slice(0, request.limit).map(({ entry }) => ({ entry, relation: "matched" }));
  const seeds = new Set(selected.map(({ entry }) => entry.path)), used = new Set(seeds);
  // Direct imports and direct consumers only. They are review leads, not proof of a required change.
  const targets = new Set(selected.flatMap(({ entry }) => entry.imports.flatMap((item) => item.target ? [item.target] : [])));
  let relatedTotal = 0;
  for (const entry of entries) {
    if (used.has(entry.path)) continue;
    const relation = targets.has(entry.path) ? "direct_import" : entry.imports.some((item) => item.target && seeds.has(item.target)) ? "direct_consumer" : null;
    if (!relation) continue;
    relatedTotal++;
    if (selected.length < request.limit + 10) { selected.push({ entry, relation }); used.add(entry.path); }
  }
  const freshness = new Map<string, { sha256: string | null; state: string }>();
  const check = async (path: string, expected: string) => {
    let actual = freshness.get(path);
    if (!actual) {
      try { actual = { sha256: digest(await safeSource(files, path, config)), state: "readable" }; }
      catch { actual = { sha256: null, state: "missing_or_unreadable" }; }
      freshness.set(path, actual);
    }
    return actual.sha256 === expected ? "current" : actual.sha256 ? "changed" : actual.state;
  };
  const fileResults = []; let fileBytes = 0;
  for (const { entry, relation } of request.model_id ? [] : selected) {
    const result = { ...entry, relation, source_state: await check(entry.path, entry.sha256),
      imports: entry.imports.slice(0, 12), imports_truncated: entry.imports_truncated || entry.imports.length > 12 };
    const bytes = Buffer.byteLength(JSON.stringify(result)); if (fileBytes + bytes > 40_000) break;
    fileResults.push(result); fileBytes += bytes;
  }
  const worktree = await readWorktreeModels(files, knowledge);
  const eligibleModels = worktree.models.filter(model => modelVisible(model, config));
  const evidence = new ModelEvidence(files, config, new Map(entries.map((entry) => [entry.path, entry])), map.repo_identity);
  const materialize = (model: typeof eligibleModels[number]) => materializeModel(model, evidence, eligibleModels);
  // 详情单独返回，容量由模型存储的 64 KiB 上限约束；不能借 ID 绕过来源排除规则。
  if (request.model_id) {
    const selection = knowledge?.modules?.find(item => item.model_id === request.model_id);
    const historical = !!request.model_snapshot_id;
    const candidate = request.model_snapshot_id
      ? await readModelSnapshot(await bindWorktree(files.root), request.model_id, request.model_snapshot_id) : undefined;
    const model = candidate ? worktreeModel(files.root, candidate.content, request.model_id)
      : eligibleModels.find(entry => entry.id === request.model_id);
    if (!model && !historical && selection && selection.state !== "matched") {
      return { state: "needs_review", files: [], models: [], modules: [], scan_id: map.scan_id,
        model_selection: selection, next_step: "按 model_snapshot_id 查看候选，核对当前源码后再修订。" };
    }
    if (!model) throw new AppError("PROJECT_MODEL_NOT_FOUND", "未找到可访问的业务模型，请重新查询当前模型列表");
    if (!modelVisible(model, config)) throw new AppError("PROJECT_MODEL_NOT_FOUND", "该模型的来源不在当前项目查询范围内");
    if (request.model_revision !== undefined && model.revision !== request.model_revision) throw new AppError("PROJECT_MODEL_REVISION_CONFLICT", "模型已更新，请读取最新摘要后再获取详情");
    const materialized = await materialize(model);
    const reviewOnly = historical || knowledge?.state === "unavailable";
    const detail = selectModelRules(reviewOnly ? { ...materialized, status: "needs_review" } : materialized, request.rule_ids);
    const indexedVersions = new Map(entries.map((entry) => [entry.path, entry.sha256]));
    const pathStates = await Promise.all(model.related_paths.map(async (path) => {
      if (indexedVersions.has(path)) return evidence.pathState(path, indexedVersions.get(path)!);
      // 已从索引移除的缺失来源需要修订模型；重复扫描不能恢复它。只有仍可读的未索引文件需要重扫。
      return await evidence.pathState(path, "") === "changed" ? "unindexed" : "missing_after_scan";
    }));
    const stale = gitLine((await readGit(files.root, ["rev-parse", "HEAD"])).stdout) !== map.head
      || await mapConfigHash(files, config) !== map.config_hash || pathStates.some((state) => state !== "current" && state !== "missing_after_scan");
    return { state: stale ? "needs_rescan" : detail.status === "needs_review" ? "needs_review" : map.coverage.complete ? "indexed" : "partial", scan_id: map.scan_id,
      files: [], modules: [], models: [{ ...detail, ...(historical ? { historical_snapshot_id: request.model_snapshot_id } :
        worktree.snapshotIds.has(model.id) ? { current_snapshot_id: worktree.snapshotIds.get(model.id) } : {}) }],
      models_truncated: detail.content_truncated, next_model_offset: null,
      model_audit: auditModels(eligibleModels, new Set([model.id])),
      business_graph: businessGraph(eligibleModels, new Set([model.id]), request.relation_depth),
      ...(request.rule_ids && !reviewOnly ? { business_checks: businessScenarios([detail]) } : {}),
      report: ".project-dev/local/understanding/report.html", limitations: "模型仍是候选。请核对当前源码、适用范围和待确认问题，不能把来源匹配当成业务结论已确认。" };
  }
  const modelCandidates = eligibleModels.filter((model) => !paths.length
    || [...model.scope, ...model.related_paths, ...model.sources.flatMap((source) => { const path = sourcePath(source); return path ? [path] : []; })].some((candidate) => paths.some((path) => intersects(candidate, path))));
  const directModels = modelCandidates.filter((model) => !request.modules.length || request.modules.includes(model.module))
    .map((model) => ({ model, score: score(JSON.stringify([model.title, model.summary, model.entities, model.rules, model.flows, model.questions, model.related_paths, model.schema_version !== 1 ? model.relations : []])) }))
    .filter((item) => !terms.length || paths.length || request.modules.length || item.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
  const directIds = new Set(directModels.map((item) => item.model.id));
  const graph = businessGraph(eligibleModels, directIds, request.relation_depth);
  const relationIds = new Set(graph.nodes.map(node => node.id).filter(id => !directIds.has(id)));
  const rankedModels = [...directModels, ...eligibleModels.filter((model) => !directIds.has(model.id) && relationIds.has(model.id))
    .sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({ model, score: 0 }))];
  const modelResults: Record<string, unknown>[] = [];
  let modelBytes = 2;
  const page = rankedModels.slice(request.model_offset, request.model_offset + 5);
  for (const { model } of page) {
    const view = await materialize(model);
    const full = knowledge?.state === "unavailable" ? { ...view, status: "needs_review" } : view;
    const details_request = { model_id: model.id, model_revision: model.revision };
    // 给本页后续摘要预留容量，避免一个大模型截断整个列表，也不截掉业务流程的中间文本。
    const preview = modelPreview(full, request.query, paths);
    const detail = { ...full, content_truncated: false, details_request };
    const remaining = page.length - modelResults.length - 1;
    const match_reason = directIds.has(model.id) ? "direct" : "business_relation";
    const detailResult = { ...detail, match_reason };
    const result = model.schema_version === 1 && modelBytes + 1 + Buffer.byteLength(JSON.stringify(detailResult)) + remaining * 4_500 <= 36_000
      ? detailResult : { ...preview, match_reason };
    const item = worktree.snapshotIds.has(model.id) ? { ...result, current_snapshot_id: worktree.snapshotIds.get(model.id) } : result;
    modelResults.push(item); modelBytes += 1 + Buffer.byteLength(JSON.stringify(item));
  }
  const head = gitLine((await readGit(files.root, ["rev-parse", "HEAD"])).stdout);
  const stale = head !== map.head || await mapConfigHash(files, config) !== map.config_hash || fileResults.some((entry) => entry.source_state !== "current");
  const modules = moduleSummary(entries);
  return { state: stale ? "needs_rescan" : modelResults.some((model) => model.status === "needs_review") ? "needs_review" : map.coverage.complete ? "indexed" : "partial", scan_id: map.scan_id,
    implementation_context: await implementationContext(files, entries, config, paths, request.query, ranking),
    model_audit: auditModels(eligibleModels, new Set(page.map(item => item.model.id))),
    business_graph: graph,
    impact: impactCandidates(entries, eligibleModels, paths.length ? paths : selected.slice(0, request.limit).map(item => item.entry.path)),
    snapshot: { head: map.head, scanned_at: map.scanned_at, coverage: map.coverage }, files: fileResults,
    files_truncated: matched.length > request.limit || relatedTotal > 10 || fileResults.length < selected.length,
    unindexed_paths: paths.filter((path) => !entries.some((entry) => intersects(path, entry.path))),
    modules: modules.slice(0, 40), modules_truncated: modules.length > 40,
    models: modelResults, models_truncated: rankedModels.length > request.model_offset + modelResults.length || modelResults.some((model) => model.content_truncated),
    next_model_offset: rankedModels.length > request.model_offset + modelResults.length ? request.model_offset + modelResults.length : null,
    report: ".project-dev/local/understanding/report.html",
    limitations: "结构和字面导入关系用于定位代码，不能覆盖完整的语法树、运行时关系或业务模型。仅对选中来源实时核验；新增文件需要重新扫描。作出判断前，请阅读相关源码、实际安装的组件版本和业务文档。候选模型未经规则确认，也不构成操作授权。" };
}
