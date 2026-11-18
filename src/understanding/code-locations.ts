import { digest } from "../knowledge/document.js";
import type { ProjectConfig } from "../knowledge/config.js";
import type { ProjectFiles } from "../storage/project-files.js";
import type { MapFile } from "./contracts.js";
import { aliases, importCandidates, safeSource } from "./scan.js";
import { loadSymbolIndex } from "./load-symbol-index.js";

type Location = { path: string; symbol: string };

/** 在当前结构快照内沿显式别名查到声明。导航可跨文件，修改范围始终绑定实际声明位置。 */
export async function codeLocations(files: ProjectFiles, config: ProjectConfig, entries: MapFile[], requested: Location[]) {
  const indexed = new Map(entries.map(item => [item.path, item]));
  const paths = new Set(indexed.keys()), mappings = await aliases(files, config);
  const { codeSymbols } = await loadSymbolIndex();
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof inspect>>>>();
  async function inspect(path: string) {
    const entry = indexed.get(path);
    if (!entry) return { state: "unindexed" as const };
    try {
      const text = await safeSource(files, path, config);
      if (digest(text) !== entry.sha256) return { state: "stale" as const };
      const parsed = codeSymbols(path, text);
      return { state: parsed.state, parsed };
    } catch { return { state: "unreadable" as const }; }
  }
  async function locate(start: Location) {
    const trace: Location[] = [];
    let current = start, mustExport = false;
    for (let hop = 0; hop <= 4; hop++) {
      if (trace.some(item => item.path === current.path && item.symbol === current.symbol)) return { state: "cycle", trace };
      trace.push(current);
      let pending = cache.get(current.path);
      if (!pending) { pending = inspect(current.path); cache.set(current.path, pending); }
      const data = await pending;
      if (data.state !== "parsed") return { state: data.state, trace };
      const [name, ...members] = current.symbol.split(".");
      if (mustExport && !data.parsed.exports.has(name!)) return { state: "export_unresolved", trace };
      const exact = data.parsed.symbols.filter(item => item.name === current.symbol);
      const refs = data.parsed.references.filter(item => item.local === name);
      if (exact.length + refs.length > 1) return { state: "ambiguous", trace };
      if (exact.length === 1) return { state: "resolved", trace, declaration: { path: current.path, ...exact[0]! } };
      const link = refs[0];
      if (!link) return { state: "missing", trace };
      const candidates = link.specifier ? importCandidates(current.path, link.specifier, paths, mappings) : [current.path];
      if (candidates.length > 1) return { state: "ambiguous_import", trace };
      const target = candidates[0];
      if (!target) return { state: "unresolved_import", trace };
      current = { path: target, symbol: [link.imported, ...members].join(".") };
      mustExport = !!link.specifier;
    }
    return { state: "depth_limit", trace };
  }
  const locations = [];
  for (const request of requested) locations.push({ ...request, ...await locate(request) });
  return locations;
}
