import { AppError } from "../domain/error.js";
import { digest } from "../knowledge/document.js";
import type { ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { safeSource, sourceBoundary, excluded } from "./scan.js";
import { CodeBindingInput, type CodeBinding, type SavedBinding } from "./semantic-contracts.js";
import { loadSymbolIndex } from "./load-symbol-index.js";

type SymbolIndex = Awaited<ReturnType<typeof loadSymbolIndex>>;

/** 一次核对内按文件复用原文、内容指纹和静态解析，不跨任务保留源码。 */
export class CodeBindingResolver {
  private readonly sources = new Map<string, Promise<{ text: string; sha256: string }>>();
  private readonly indexes = new Map<string, Promise<ReturnType<SymbolIndex["codeSymbols"]>>>();
  constructor(private readonly files: ProjectFiles, private readonly config: ProjectConfig) {}

  source(path: string) {
    let source = this.sources.get(path);
    if (!source) {
      source = safeSource(this.files, path, this.config).then(text => ({ text, sha256: digest(text) }));
      this.sources.set(path, source);
    }
    return source;
  }

  /** 定位状态、范围和内容指纹由程序产生。 */
  async resolve(raw: CodeBinding): Promise<SavedBinding> {
    const binding = CodeBindingInput.parse(raw);
    if (excluded(binding.path, this.config)) throw new AppError("BUSINESS_BINDING_EXCLUDED", "业务绑定不能访问已排除的路径");
    const empty = { ...binding, target_sha256: null, symbol_sha256: null, start: null, end: null };
    let source;
    try { source = await this.source(binding.path); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      await this.files.path(binding.path, true);
      await sourceBoundary(this.files, binding.path, this.config);
      return { ...empty, resolution: binding.planned ? "planned" : "missing" };
    }
    const base = { ...empty, target_sha256: source.sha256 };
    if (!binding.symbol) return { ...base, resolution: "resolved" };
    let index = this.indexes.get(binding.path);
    if (!index) {
      index = loadSymbolIndex().then(({ codeSymbols }) => codeSymbols(binding.path, source.text));
      this.indexes.set(binding.path, index);
    }
    const parsed = await index;
    if (parsed.state !== "parsed") return { ...base, resolution: "unsupported" };
    const matching = parsed.symbols.filter(symbol => symbol.name === binding.symbol);
    if (matching.length > 1) return { ...base, resolution: "ambiguous" };
    const symbol = matching[0];
    if (!symbol) return { ...base, resolution: binding.planned ? "planned" : "missing" };
    return { ...base, resolution: "resolved", symbol_sha256: symbol.sha256, start: symbol.start, end: symbol.end };
  }
}
