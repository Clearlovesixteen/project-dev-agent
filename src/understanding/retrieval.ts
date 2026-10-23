import type { MapFile } from "./contracts.js";
import { safeSource, excluded } from "./scan.js";
import { digest } from "../knowledge/document.js";
import type { ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";

/** 词法检索只是定位线索；保留后端接口，后续语言服务不能绕过相同的来源边界。 */
export interface RetrievalProvider {
  readonly name: string;
  rank(entry: MapFile, query: string): RetrievalMatch;
}
export interface RetrievalMatch { score: number; reasons: { kind: string; terms: string[] }[]; symbol: string | null }
const SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

export function queryTerms(text: string): string[] {
  const expanded = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[_\-./]+/g, " ").toLowerCase();
  return [...new Set([...SEGMENTER.segment(expanded)]
    .filter(part => part.isWordLike).map(part => part.segment))].slice(0, 50);
}
const canonical = (value: string) => value.replace(/[^a-z0-9\u3400-\u9fff]/gi, "").toLowerCase();

export const lexicalProvider: RetrievalProvider = {
  name: "lexical",
  rank(entry, query) {
    const terms = queryTerms(query), raw = query.toLowerCase(), compact = canonical(query);
    if (!terms.length) return { score: 0, reasons: [], symbol: null };
    const reasons: RetrievalMatch["reasons"] = []; let score = 0; let symbol: string | null = null; let symbolScore = 0;
    const symbols = entry.symbols ?? [], identifiers = entry.identifiers ?? [];
    const exact = symbols.filter(name => new RegExp(`(?<![\\w$])${escapePattern(name)}(?![\\w$])`, "i").test(raw) || compact.length >= 4 && canonical(name) === compact);
    if (exact.length) { score += 120; reasons.push({ kind: "exact_symbol", terms: exact.slice(0, 4) }); symbol = exact[0]!; }
    const symbolHits = new Set<string>();
    for (const name of symbols) {
      const words = new Set(queryTerms(name)), hits = terms.filter(term => words.has(term));
      for (const hit of hits) symbolHits.add(hit);
      if (!exact.length && hits.length > symbolScore) { symbolScore = hits.length; symbol = name; }
    }
    const add = (kind: string, hits: string[], weight: number) => { if (hits.length) { score += hits.length * weight; reasons.push({ kind, terms: hits.slice(0, 10) }); } };
    add("symbol_words", [...symbolHits], 16);
    const identifierWords = new Set(identifiers.flatMap(queryTerms));
    add("identifier_words", terms.filter(term => identifierWords.has(term)), 5);
    const pathWords = new Set(queryTerms(entry.path));
    add("path_words", terms.filter(term => pathWords.has(term)), 4);
    const metadata = [entry.module, entry.role, ...entry.imports.map(item => item.specifier)].join(" ").toLowerCase();
    add("module_or_import", terms.filter(term => metadata.includes(term)), 2);
    return { score, reasons, symbol };
  },
};

/** 新模块仍可查询所属应用与仓库根级公共能力，不因目录不存在就认定没有实现。 */
export function implementationScope(path: string, targets: string[]): boolean {
  if (!targets.length) return true;
  const owner = (value: string) => /^(?:apps|packages)\/[^/]+(?:\/|$)/.exec(value)?.[0].replace(/\/$/, "");
  const candidate = owner(path);
  return !candidate || targets.some(target => owner(target) === candidate);
}
const sourceFile = (path: string) => /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|java|kt|cs|rs)$/.test(path);
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function codeOnly(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, value => value.replace(/[^\n]/g, " "));
}
function symbolPosition(text: string, symbol: string | null) {
  if (!symbol) return null;
  const clean = codeOnly(text), match = new RegExp(`(?<![\\w$])${escapePattern(symbol)}(?![\\w$])`).exec(clean);
  if (!match) return null;
  const prefix = clean.slice(0, match.index), line = prefix.split("\n").length;
  return { line, column: match.index - prefix.lastIndexOf("\n"), quote: (text.split(/\r?\n/)[line - 1] ?? "").trim().slice(0, 240) };
}

/** 只展示实时读到的导入与局部名称用法，不将同名标识符冒充语义调用图。 */
function usageExcerpt(text: string, specifier: string, indexedLine: number) {
  const lines = text.split(/\r?\n/), indexed = lines[indexedLine - 1];
  const line = indexed?.includes(specifier) ? indexedLine : lines.findIndex(value => value.includes(specifier) && /\b(?:import|export|require)\b/.test(value)) + 1;
  if (!line) return null;
  let start = line - 1;
  for (let index = line - 1; index >= Math.max(0, line - 9); index--) {
    if (/^\s*(?:import|export|const|let)\b/.test(lines[index] ?? "")) { start = index; break; }
  }
  const statement = lines.slice(start, line).join("\n");
  const named = /\bimport(?:\s+type)?(?:\s+[\w$]+\s*,)?\s*\{([^}]+)\}/.exec(statement)?.[1]?.split(",").map(value => value.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)!).filter(value => /^[\w$]+$/.test(value)) ?? [];
  const single = /\bimport\s+(?:type\s+)?([\w$]+)|\*\s+as\s+([\w$]+)|\b(?:const|let)\s+([\w$]+)\s*=\s*require/.exec(statement);
  const names = [...new Set([...named, ...single?.slice(1).filter((value): value is string => !!value) ?? []])];
  const clean = codeOnly(text).split("\n");
  const usage = clean.findIndex((value, index) => index + 1 > line && !/^\s*(?:import|export\s*\{)/.test(value)
    && names.some(name => new RegExp(`(?<![\\w$])${escapePattern(name)}(?![\\w$])`).test(value)));
  return { import_line: line, import_quote: (lines[line - 1] ?? "").trim().slice(0, 240),
    usage: usage >= 0 ? { line: usage + 1, quote: (lines[usage] ?? "").trim().slice(0, 240) } : null,
    relation: usage >= 0 ? "import_and_identifier" : "import_only" };
}

export async function implementationCandidates(files: ProjectFiles, entries: MapFile[], config: ProjectConfig, paths: string[], query: string,
  provider: RetrievalProvider = lexicalProvider) {
  const eligible = entries.filter(entry => !excluded(entry.path, config) && sourceFile(entry.path) && entry.role !== "test" && implementationScope(entry.path, paths));
  const consumers = new Map<string, { entry: MapFile; specifier: string; line: number }[]>();
  for (const entry of eligible) for (const item of entry.imports) if (item.target) {
    const list = consumers.get(item.target) ?? []; if (!list.some(value => value.entry.path === entry.path)) list.push({ entry, specifier: item.specifier, line: item.line }); consumers.set(item.target, list);
  }
  const ranked = eligible.map(entry => ({ entry, match: provider.rank(entry, query) }))
    .sort((a, b) => b.match.score - a.match.score || Number(b.entry.role === "shared") - Number(a.entry.role === "shared")
      || (consumers.get(b.entry.path)?.length ?? 0) - (consumers.get(a.entry.path)?.length ?? 0) || a.entry.path.localeCompare(b.entry.path));
  const matched = queryTerms(query).length ? ranked.filter(value => value.match.score > 0) : ranked;
  const fallback = matched.length === 0;
  const selected = (fallback ? ranked.filter(value => value.entry.role === "shared" || consumers.has(value.entry.path)) : matched).slice(0, 8);
  const cache = new Map<string, { text: string; sha256: string } | null>(); let bytes = 0; let partial = false;
  const read = async (entry: MapFile) => {
    if (cache.has(entry.path)) return cache.get(entry.path)!;
    if (cache.size >= 24 || bytes >= 2_000_000) { partial = true; return null; }
    try {
      const text = await safeSource(files, entry.path, config); bytes += Buffer.byteLength(text);
      if (bytes > 2_000_000) { partial = true; cache.set(entry.path, null); return null; }
      const source = { text, sha256: digest(text) }; cache.set(entry.path, source); return source;
    } catch { partial = true; cache.set(entry.path, null); return null; }
  };
  const candidates = [];
  for (const { entry, match } of selected) {
    const source = await read(entry); if (!source) continue;
    const symbol = match.symbol ?? entry.symbols?.[0] ?? null;
    const position = symbolPosition(source.text, symbol);
    const examples = [];
    for (const caller of (consumers.get(entry.path) ?? []).slice(0, 2)) {
      const current = await read(caller.entry); if (!current) continue;
      const excerpt = usageExcerpt(current.text, caller.specifier, caller.line); if (!excerpt) { partial = true; continue; }
      examples.push({ path: caller.entry.path, sha256: current.sha256, source_state: current.sha256 === caller.entry.sha256 ? "current" : "changed", ...excerpt });
    }
    candidates.push({ provider: provider.name, path: entry.path, sha256: source.sha256, indexed_sha256: entry.sha256,
      source_state: source.sha256 === entry.sha256 ? "current" : "changed", symbol, position,
      match_reasons: fallback ? [{ kind: "structural_fallback", terms: [] }] : match.reasons,
      consumers: examples, consumer_count: consumers.get(entry.path)?.length ?? 0, consumers_truncated: (consumers.get(entry.path)?.length ?? 0) > 2 });
    if (source.sha256 !== entry.sha256 || examples.some(example => example.source_state !== "current")) partial = true;
  }
  return { provider: provider.name, state: partial ? "partial" : !candidates.length ? "no_index_match" : fallback || !queryTerms(query).length ? "structural_fallback" : "matched",
    candidates, truncated: partial || (fallback ? ranked.length : matched.length) > selected.length,
    limitations: "词法命中和导入用法是阅读线索，不证明语义绑定、适用性或项目不存在其他实现；无命中时应继续换关键词、阅读源码或刷新索引。" };
}
