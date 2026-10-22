import { lexicalReferences } from "./lexical.js";
import { posix } from "node:path";
import { lstat } from "node:fs/promises";
import { AppError } from "../domain/error.js";
import { RelativePathSchema } from "../domain/common.js";
import { readGit, decodeGitOutput, gitLine } from "../git/command.js";
import type { WorktreeBinding } from "../git/index.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { loadConfig, matchesPath, type ProjectConfig } from "../knowledge/config.js";
import { FileSchema, MAP_DIR, MapSchema, type MapFile, type ProjectMap } from "./contracts.js";
import { mapFiles, optional, save } from "./store.js";

export const MAX_SOURCE = 512_000;
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".css", ".less", ".scss", ".json", ".yaml", ".yml", ".md", ".mdx", ".html", ".py", ".go", ".java", ".kt", ".cs", ".rs", ".sql", ".toml", ".xml", ".graphql", ".gql"]);
const SKIP = new Set([".git", "node_modules", "dist", "build", "coverage", "vendor", ".next", ".nuxt", ".cache", ".project-dev", ".codex", ".agents", "__pycache__"]);
export function excluded(path: string, config: ProjectConfig): boolean {
  return path.split("/").some((part) => SKIP.has(part) || /^\.env(?:\.|$)/i.test(part) || /^(?:credentials|secrets?)(?:\.|$)/i.test(part))
    || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$|\.(?:min\.js|map|pem|key|p12|pfx)$/i.test(path)
    || config.exclude_paths.some((pattern) => matchesPath(pattern, path));
}
async function sourceBoundary(files: ProjectFiles, path: string, config: ProjectConfig): Promise<void> {
  if (excluded(path, config)) throw new AppError("PROJECT_SOURCE_EXCLUDED", "该来源已被排除在项目理解范围之外");
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    try { await lstat(`${files.root}/${parts.slice(0, i).join("/")}/.git`); throw new AppError("PROJECT_SOURCE_NESTED", "嵌套仓库需要单独扫描"); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
}
export async function safeSource(files: ProjectFiles, path: string, config: ProjectConfig): Promise<string> {
  await sourceBoundary(files, path, config);
  return files.read(path, MAX_SOURCE);
}

/** 元数据仅用于复用结构解析；每次仍检查真实路径、嵌套仓库和文件类型，业务证据另行读取原文。 */
async function sourceSignature(files: ProjectFiles, path: string, config: ProjectConfig): Promise<string> {
  await sourceBoundary(files, path, config);
  const info = await lstat(await files.path(path), { bigint: true });
  if (!info.isFile() || info.size > BigInt(MAX_SOURCE)) throw new AppError("PROJECT_SOURCE_UNSAFE", "来源必须是容量范围内的普通文件");
  return digest(["structure-v1", info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":"));
}
/** JSON with comments/trailing commas, preserving strings; no config code or extends execution. */
function jsonc(text: string): unknown {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, quoted) => quoted ?? match.replace(/[^\n]/g, " "))
    .replace(/("(?:\\.|[^"\\])*")|,\s*([}\]])/g, (match, quoted, close) => quoted ?? close));
}
type Alias = { prefix: string; suffix: string; targets: string[]; wildcard: boolean };
export async function aliases(files: ProjectFiles, config: ProjectConfig): Promise<Alias[]> {
  for (const path of ["tsconfig.json", "jsconfig.json"]) {
    if (excluded(path, config)) continue;
    try {
      const parsed = jsonc(await files.read(path, MAX_SOURCE)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } };
      const options = parsed.compilerOptions;
      return Object.entries(options?.paths ?? {}).slice(0, 100).flatMap(([pattern, values]) => {
        if (!Array.isArray(values) || !values.every((value) => typeof value === "string") || pattern.split("*").length > 2) return [];
        const targets = (values as string[]).slice(0, 10).map((value) => posix.join(options?.baseUrl ?? ".", value));
        return [{ prefix: pattern.split("*")[0]!, suffix: pattern.includes("*") ? pattern.split("*")[1]! : "", targets, wildcard: pattern.includes("*") }];
      });
    } catch { /* Unsupported config forms remain unresolved rather than guessed. */ }
  }
  return [];
}
export async function mapConfigHash(files: ProjectFiles, config: ProjectConfig): Promise<string> {
  const configs: unknown[] = [config];
  for (const path of ["tsconfig.json", "jsconfig.json"]) {
    if (excluded(path, config)) continue;
    try { configs.push([path, digest(await files.read(path, MAX_SOURCE))]); } catch { configs.push([path, null]); }
  }
  return digest(JSON.stringify(configs));
}
function moduleFor(path: string, config: ProjectConfig): string {
  const declared = config.modules.find((module) => module.paths.some((pattern) => matchesPath(pattern, path)));
  if (declared) return declared.name;
  const match = /^(?:(?:src\/)?(?:pages|features|modules)|apps|packages)\/([^/]+)\//.exec(path);
  if (match) return path.slice(0, match[0]!.length - 1);
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0]! : "(root)";
}
function roleFor(path: string): MapFile["role"] {
  if (/(?:^|\/)(?:__tests__|tests?|e2e)(?:\/|\.)|\.(?:spec|test)\./i.test(path)) return "test";
  if (/\.(?:md|mdx|html)$/i.test(path) || /(?:^|\/)docs?\//.test(path)) return "document";
  if (/(?:^|\/)(?:api|apis|services?)\//i.test(path)) return "api";
  if (/(?:^|\/)(?:components|hooks|utils|shared|common)\//i.test(path)) return "shared";
  if (/(?:^|\/)(?:router|routes)(?:\.|\/)|(?:^|\/)(?:main|app)\.[jt]sx?$/i.test(path)) return "entry";
  if (/(?:^|\/)(?:pages|views)\//i.test(path)) return "page";
  if (/(?:^|\/)(?:package\.json|[^/]*config[^/]*|\.eslintrc[^/]*|\.prettierrc[^/]*)$/i.test(path)) return "config";
  return "source";
}
function literalImports(text: string): { specifier: string; line: number }[] {
  // Preserve strings while removing comments. This is a lexical navigation aid, not an AST or call graph.
  const clean = text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, quoted) => quoted ?? match.replace(/[^\n]/g, " "));
  const expression = /(?:\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?|\b(?:import|require)\s*\(\s*)['"]([^'"\n]{1,300})['"]/g;
  const result: { specifier: string; line: number }[] = [];
  for (const match of clean.matchAll(expression)) {
    result.push({ specifier: match[1]!, line: clean.slice(0, match.index).split("\n").length });
    if (result.length > 40) break;
  }
  return result;
}
function resolveImport(path: string, specifier: string, all: Set<string>, mappings: Alias[]): string | null {
  const bases = specifier.startsWith(".") ? [posix.join(posix.dirname(path), specifier)] : mappings.flatMap((alias) => {
    if (!alias.wildcard) return specifier === alias.prefix ? alias.targets : [];
    if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return [];
    const middle = specifier.slice(alias.prefix.length, alias.suffix ? -alias.suffix.length : undefined);
    return alias.targets.map((target) => target.replace("*", middle));
  });
  for (const base of bases) {
    const normalized = posix.normalize(base);
    if (!RelativePathSchema.safeParse(normalized).success) continue;
    const alternatives = [normalized, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json"].flatMap((ext) => [normalized + ext, `${normalized}/index${ext}`])];
    if (/\.[cm]?js$/.test(normalized)) alternatives.push(normalized.replace(/\.[cm]?js$/, ".ts"), normalized.replace(/\.[cm]?js$/, ".tsx"));
    const found = alternatives.find((candidate) => all.has(candidate)); if (found) return found;
  }
  return null;
}
export async function scanProject(binding: WorktreeBinding): Promise<ProjectMap> {
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const configBefore = await mapConfigHash(files, config);
  const before = gitLine((await readGit(binding.root, ["rev-parse", "HEAD"])).stdout);
  const paths = [...new Set(decodeGitOutput((await readGit(binding.root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout).split("\0").filter(Boolean))].sort();
  const previous = new Map((await mapFiles(files)).map((file) => [file.path, file]));
  const records: MapFile[] = [], diagnostics: ProjectMap["diagnostics"] = [];
  const coverage = { discovered: paths.length, indexed: 0, excluded: 0, unreadable: 0, unsupported: 0, reused: 0, complete: true, content_reused: 0, read_files: 0, read_bytes: 0 };
  const eligible = paths.filter((path) => {
    if (excluded(path, config)) { coverage.excluded++; return false; }
    if (!EXTENSIONS.has(posix.extname(path)) && !/^(?:Dockerfile|Makefile|\.eslintrc|\.prettierrc)$/.test(posix.basename(path))) { coverage.unsupported++; return false; }
    return true;
  });
  const all = new Set(eligible), mappings = await aliases(files, config);
  let totalBytes = 0;
  const diagnostic = (code: string, message: string) => { coverage.complete = false; if (diagnostics.length < 100) diagnostics.push({ code, message: message.slice(0, 500) }); };
  for (const path of eligible) {
    if (records.length >= 10_000 || totalBytes >= 80_000_000) { diagnostic("PROJECT_SCAN_LIMIT", "剩余文件超出 10,000 个文件或 80 MB 的读取上限；本次扫描仅覆盖部分范围"); break; }
    try {
      const stat_signature = await sourceSignature(files, path, config), prior = previous.get(path);
      const cached = prior?.stat_signature === stat_signature && (posix.basename(path) !== "package.json" || prior.package);
      const content = cached ? null : await safeSource(files, path, config);
      const bytes = content === null ? prior!.bytes : Buffer.byteLength(content); totalBytes += bytes;
      if (content === null) coverage.content_reused++;
      else { coverage.read_files++; coverage.read_bytes += bytes; }
      if (content?.includes("\0")) { coverage.unsupported++; continue; }
      const sha256 = content === null ? prior!.sha256 : digest(content);
      if (await sourceSignature(files, path, config) !== stat_signature) throw new AppError("PROJECT_SOURCE_CHANGED", "读取期间来源变化，请重新扫描");
      const imports = prior?.sha256 === sha256 ? prior.imports : /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(path) ? literalImports(content!) : [];
      if (prior?.sha256 === sha256) coverage.reused++;
      let pkg: MapFile["package"] = cached ? prior?.package : undefined;
      if (posix.basename(path) === "package.json" && content !== null) {
        try {
          const value = JSON.parse(content);
          const entries = Object.entries({ ...value.dependencies, ...value.devDependencies }).filter(([name, value]) => name.length <= 200 && typeof value === "string" && value.length <= 200);
          const scripts = Object.keys(value.scripts ?? {}).filter((name) => name.length <= 100);
          pkg = { dependencies: entries.slice(0, 120).map(([name, declared]) => ({ name, declared: String(declared) })), scripts: scripts.slice(0, 40), truncated: entries.length > 120 || scripts.length > 40 };
        } catch { diagnostic("PROJECT_PACKAGE_INVALID", `${path}：无法解析依赖声明`); }
      }
      records.push(FileSchema.parse({ path, sha256, bytes, stat_signature, ...(content === null ? { symbols: prior!.symbols, identifiers: prior!.identifiers, identifiers_truncated: prior!.identifiers_truncated } : lexicalReferences(content)), module: moduleFor(path, config), role: roleFor(path),
        imports: imports.slice(0, 40).map((entry) => ({ specifier: entry.specifier, line: entry.line, target: resolveImport(path, entry.specifier, all, mappings) })),
        imports_truncated: prior?.sha256 === sha256 ? prior.imports_truncated : imports.length > 40, ...(pkg ? { package: pkg } : {}) }));
    } catch (error) { coverage.unreadable++; diagnostic("PROJECT_FILE_UNREADABLE", `${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // Failed/unsafe targets never become resolved cross-file evidence.
  const indexed = new Set(records.map((record) => record.path));
  for (const record of records) for (const entry of record.imports) if (entry.target && !indexed.has(entry.target)) entry.target = null;
  if (gitLine((await readGit(binding.root, ["rev-parse", "HEAD"])).stdout) !== before) throw new AppError("PROJECT_SCAN_CHANGED", "扫描期间 HEAD 已变化，请重试");
  coverage.indexed = records.length;
  const chunks: string[] = []; let group: MapFile[] = [];
  const flush = async () => { if (!group.length) return; const raw = JSON.stringify(group) + "\n", id = digest(raw);
    const target = `${MAP_DIR}/chunks/${id}.json`, existing = await optional(files, target);
    if (existing === undefined) await files.create(target, raw); else if (existing !== raw) throw new AppError("PROJECT_MAP_CORRUPT", "现有不可变分块的内容不一致");
    chunks.push(id); group = []; };
  for (const record of records) {
    if (Buffer.byteLength(JSON.stringify([...group, record])) > 48_000) await flush();
    group.push(record);
  }
  await flush();
  const config_hash = await mapConfigHash(files, config);
  if (configBefore !== config_hash || digest(JSON.stringify((await loadConfig(files)).config)) !== digest(JSON.stringify(config))) throw new AppError("PROJECT_SCAN_CHANGED", "扫描期间项目配置已变化，请重试");
  const map = MapSchema.parse({ schema_version: 1, project: binding.root, repo_identity: binding.repo_identity, head: before, scanned_at: new Date().toISOString(),
    config_hash, scan_id: digest(JSON.stringify([1, binding.root, before, config_hash, chunks])), chunks, coverage, diagnostics });
  await save(files, `${MAP_DIR}/manifest.json`, map);
  return map;
}
