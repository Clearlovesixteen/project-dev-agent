import { ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { loadConfig } from "../knowledge/config.js";
import { gitLine, readGit } from "../git/command.js";
import { ContextInput, type MapFile, type SavedModel } from "./contracts.js";
import { mapFiles, models, readMap } from "./store.js";
import { excluded, mapConfigHash, safeSource } from "./scan.js";
import { AppError } from "../domain/error.js";

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
export async function projectContext(files: ProjectFiles, input: unknown) {
  const request = ContextInput.parse(input), map = await readMap(files);
  if (!map) return { state: "not_scanned", files: [], models: [], modules: [], next_step: "请运行 project_scan 建立本地项目结构索引。" };
  const { config } = await loadConfig(files);
  const paths = request.paths.filter((path) => !excluded(path, config));
  if (request.paths.length && !paths.length) return { state: "paths_excluded", files: [], models: [], modules: [] };
  const entries = (await mapFiles(files)).filter((entry) => !excluded(entry.path, config));
  const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(request.query.toLowerCase())].filter((term) => term.isWordLike).map((term) => term.segment).slice(0, 50);
  const score = (text: string) => terms.filter((term) => text.toLowerCase().includes(term)).length;
  const matched = entries.filter((entry) => (!paths.length || paths.some((path) => intersects(path, entry.path))) && (!request.modules.length || request.modules.includes(entry.module)))
    .map((entry) => ({ entry, score: score([entry.path, entry.module, entry.role, ...entry.imports.map((item) => item.specifier)].join(" ")) }))
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
  for (const { entry, relation } of selected) {
    const result = { ...entry, relation, source_state: await check(entry.path, entry.sha256),
      imports: entry.imports.slice(0, 12), imports_truncated: entry.imports_truncated || entry.imports.length > 12 };
    const bytes = Buffer.byteLength(JSON.stringify(result)); if (fileBytes + bytes > 40_000) break;
    fileResults.push(result); fileBytes += bytes;
  }
  const eligibleModels = (await models(files)).filter((model) =>
    model.sources.every((source) => !excluded(source.path, config)) && model.related_paths.every((path) => !excluded(path, config)));
  const materialize = async (model: SavedModel) => {
    const source_states = [];
    for (const source of model.related_versions) source_states.push({ path: source.path, state: await check(source.path, source.sha256) });
    return { ...model, status: source_states.every((source) => source.state === "current") ? "candidate" : "needs_review", effective: false as const, source_states };
  };
  // 详情单独返回，容量由模型存储的 64 KiB 上限约束；不能借 ID 绕过来源排除规则。
  if (request.model_id) {
    const model = eligibleModels.find((entry) => entry.id === request.model_id);
    if (!model) throw new AppError("PROJECT_MODEL_NOT_FOUND", "未找到可访问的业务模型，请重新查询当前模型列表");
    if (request.model_revision !== undefined && model.revision !== request.model_revision) throw new AppError("PROJECT_MODEL_REVISION_CONFLICT", "模型已更新，请读取最新摘要后再获取详情");
    const detail = await materialize(model);
    const stale = gitLine((await readGit(files.root, ["rev-parse", "HEAD"])).stdout) !== map.head
      || await mapConfigHash(files, config) !== map.config_hash || detail.status === "needs_review";
    return { state: stale ? "needs_rescan" : map.coverage.complete ? "indexed" : "partial", scan_id: map.scan_id,
      files: [], modules: [], models: [detail], models_truncated: false, next_model_offset: null,
      report: ".project-dev/local/understanding/report.html", limitations: "模型仍是候选。请核对当前源码、适用范围和待确认问题，不能把来源匹配当成业务结论已确认。" };
  }
  const modelCandidates = eligibleModels.filter((model) => !paths.length
    || [...model.scope, ...model.related_paths, ...model.sources.map((source) => source.path)].some((candidate) => paths.some((path) => intersects(candidate, path))));
  const rankedModels = modelCandidates.filter((model) => !request.modules.length || request.modules.includes(model.module))
    .map((model) => ({ model, score: score(JSON.stringify([model.title, model.summary, model.entities, model.rules, model.flows, model.questions, model.related_paths])) }))
    .filter((item) => !terms.length || paths.length || request.modules.length || item.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
  const modelResults: Record<string, unknown>[] = [];
  let modelBytes = 2;
  const page = rankedModels.slice(request.model_offset, request.model_offset + 5);
  for (const { model } of page) {
    const full = await materialize(model);
    const details_request = { model_id: model.id, model_revision: model.revision };
    // 给本页后续摘要预留容量，避免一个大模型截断整个列表，也不截掉业务流程的中间文本。
    const preview = { id: model.id, revision: model.revision, module: model.module, title: model.title,
      summary: model.summary.slice(0, 400), status: full.status, effective: false, content_truncated: true,
      related_path_count: model.related_paths.length, details_request };
    const detail = { ...full, content_truncated: false, details_request };
    const remaining = page.length - modelResults.length - 1;
    const result = modelBytes + 1 + Buffer.byteLength(JSON.stringify(detail)) + remaining * 4_096 <= 36_000 ? detail : preview;
    modelResults.push(result); modelBytes += 1 + Buffer.byteLength(JSON.stringify(result));
  }
  const head = gitLine((await readGit(files.root, ["rev-parse", "HEAD"])).stdout);
  const stale = head !== map.head || await mapConfigHash(files, config) !== map.config_hash || fileResults.some((entry) => entry.source_state !== "current");
  const modules = moduleSummary(entries);
  return { state: stale ? "needs_rescan" : map.coverage.complete ? "indexed" : "partial", scan_id: map.scan_id,
    snapshot: { head: map.head, scanned_at: map.scanned_at, coverage: map.coverage }, files: fileResults,
    files_truncated: matched.length > request.limit || relatedTotal > 10 || fileResults.length < selected.length,
    unindexed_paths: paths.filter((path) => !entries.some((entry) => intersects(path, entry.path))),
    modules: modules.slice(0, 40), modules_truncated: modules.length > 40,
    models: modelResults, models_truncated: rankedModels.length > request.model_offset + modelResults.length || modelResults.some((model) => model.content_truncated),
    next_model_offset: rankedModels.length > request.model_offset + modelResults.length ? request.model_offset + modelResults.length : null,
    report: ".project-dev/local/understanding/report.html",
    limitations: "结构和字面导入关系用于定位代码，不能覆盖完整的语法树、运行时关系或业务模型。仅对选中来源实时核验；新增文件需要重新扫描。作出判断前，请阅读相关源码、实际安装的组件版本和业务文档。候选模型未经规则确认，也不构成操作授权。" };
}
