import { parse, type ParserPlugin } from "@babel/parser";
import { digest } from "../domain/digest.js";

export interface CodeSymbol { name: string; start: number; end: number; sha256: string; }
export interface SymbolReference { local: string; imported: string; specifier?: string; }
type Node = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };
const isNode = (value: unknown): value is Node => !!value && typeof value === "object" && "type" in value && typeof value.type === "string";
const identifier = (value: unknown) => isNode(value) && ["Identifier", "StringLiteral"].includes(value.type)
  ? String(value.name ?? value.value) : undefined;
const supported = (path: string, text: string) => /\.(?:[cm]?[jt]sx?)$/.test(path) && Buffer.byteLength(text) <= 512_000;
function parseCode(path: string, text: string, tokens = false) {
  const typescript = /\.(?:ts|tsx|mts|cts)$/.test(path);
  const plugins: ParserPlugin[] = [];
  if (typescript) plugins.push("typescript");
  if (!typescript || path.endsWith(".tsx")) plugins.push("jsx");
  return parse(text, { sourceType: "unambiguous", tokens, plugins, errorRecovery: false });
}

/** 有界静态解析，保持词法作用域限定名；不能把重名、动态属性或解析失败当作唯一定位。 */
export function codeSymbols(path: string, text: string) {
  const unsupported = { state: "unsupported" as const, symbols: [] as CodeSymbol[], references: [] as SymbolReference[], exports: new Set<string>() };
  if (!supported(path, text)) return unsupported;
  const symbols: CodeSymbol[] = [];
  let inspected = 0;
  try {
    const ast = parseCode(path, text);
    const walk = (node: unknown, scope: string[], depth: number, wrapper?: { start: number; end: number }) => {
      if (++inspected > 80_000 || depth > 100) throw new Error("SYMBOL_LIMIT");
      if (!isNode(node)) return;
      let name: string | undefined;
      if (["FunctionDeclaration", "ClassDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"].includes(node.type)) name = identifier(node.id);
      else if (node.type === "VariableDeclarator") name = identifier(node.id);
      else if (["ClassMethod", "ObjectMethod", "ClassProperty", "ObjectProperty", "TSPropertySignature"].includes(node.type) && !node.computed) name = identifier(node.key);
      else if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && identifier(node.source))
        name = `${node.type === "ImportDeclaration" ? "import" : "export"}:${identifier(node.source)}`;
      const qualified = name ? [...scope, name] : scope;
      if (name && typeof node.start === "number" && typeof node.end === "number")
        symbols.push({ name: qualified.join("."), start: wrapper?.start ?? node.start, end: wrapper?.end ?? node.end,
          sha256: digest(text.slice(wrapper?.start ?? node.start, wrapper?.end ?? node.end)) });
      for (const [key, child] of Object.entries(node)) {
        if (["loc", "extra", "comments", "leadingComments", "trailingComments", "tokens"].includes(key)) continue;
        const outer = typeof node.start === "number" && typeof node.end === "number"
          && (key === "declaration" && /^Export/.test(node.type) || key === "declarations" && node.type === "VariableDeclaration" && Array.isArray(child) && child.length === 1)
          ? wrapper ?? { start: node.start, end: node.end } : undefined;
        if (Array.isArray(child)) {
          for (const item of child) if (isNode(item)) walk(item, qualified, depth + 1, outer);
        } else if (isNode(child)) walk(child, qualified, depth + 1, outer);
      }
    };
    walk(ast.program, [], 0);
    return { state: "parsed" as const, symbols, ...moduleReferences(ast.program.body) };
  } catch { return unsupported; }
}

/** 只跟踪 AST 能直接说明的导入别名和重导出，动态选择及通配重导出保持未知。 */
function moduleReferences(body: ReturnType<typeof parse>["program"]["body"]) {
  const references: SymbolReference[] = [];
  const exports = new Set<string>();
  for (const statement of body) {
    if (statement.type === "ImportDeclaration") for (const specifier of statement.specifiers) {
      const imported = specifier.type === "ImportDefaultSpecifier" ? "default" : specifier.type === "ImportSpecifier" ? identifier(specifier.imported) : undefined;
      if (imported) references.push({ local: specifier.local.name, imported, specifier: statement.source.value });
    }
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      const names = declaration?.type === "VariableDeclaration" ? declaration.declarations.map(item => identifier(item.id))
        : declaration && "id" in declaration ? [identifier(declaration.id)] : [];
      for (const name of names) if (name) exports.add(name);
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ExportSpecifier") continue;
        const local = identifier(specifier.exported), imported = identifier(specifier.local);
        if (local) exports.add(local);
        if (local && imported && (statement.source || local !== imported))
          references.push({ local, imported, ...(statement.source ? { specifier: statement.source.value } : {}) });
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      const imported = declaration.type === "Identifier" ? declaration.name : "id" in declaration ? identifier(declaration.id) : undefined;
      exports.add("default");
      if (imported) references.push({ local: "default", imported });
    }
  }
  return { references: references.slice(0, 300), exports };
}

/** 去掉被授权的声明后比较语法树，避免忽略 return 换行等会改变语义的空白。 */
function outsideStructure(node: unknown, isInside: (start: number, end: number) => boolean): unknown {
  if (Array.isArray(node)) return node.map(item => outsideStructure(item, isInside)).filter(item => item !== undefined);
  if (!node || typeof node !== "object") return node;
  const entry = node as Node;
  if (typeof entry.start === "number" && typeof entry.end === "number" && isInside(entry.start, entry.end)) return undefined;
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !["start", "end", "loc", "range", "extra", "sourceType",
    "comments", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key))
    .map(([key, value]) => [key, outsideStructure(value, isInside)]).filter(([, value]) => value !== undefined));
}

/** 比较授权符号以外的真实词法内容。忽略排版空白，保留注释、字符串和模板内容的差异。 */
export function outsideBindings(path: string, text: string, selectors: string[]): string | undefined {
  if (!supported(path, text)) return undefined;
  try {
    const parsed = codeSymbols(path, text);
    if (parsed.state !== "parsed") return undefined;
    const ranges = selectors.flatMap(selector => parsed.symbols.filter(symbol => symbol.name === selector));
    const ast = parseCode(path, text, true), tokens = ast.tokens ?? [];
    if (tokens.length > 80_000) return undefined;
    const inside = (start: number, end: number) => ranges.some(range => start >= range.start && end <= range.end);
    const outside = tokens.filter(token => token.start! < token.end! && !inside(token.start!, token.end!))
      .map(token => text.slice(token.start!, token.end!));
    // 只比较 Program 的真实内容，避免整文件刚好落在某个授权声明范围内时删掉 Program 壳。
    const structure = [outsideStructure(ast.program.directives, inside), outsideStructure(ast.program.body, inside)];
    return digest(JSON.stringify([outside, structure, outside.length ? ast.program.sourceType : null]));
  } catch { return undefined; }
}

export function selectSymbol(path: string, text: string, selector: string) {
  const parsed = codeSymbols(path, text);
  if (parsed.state !== "parsed") return { resolution: "unsupported" as const };
  const exact = parsed.symbols.filter(symbol => symbol.name === selector);
  if (exact.length !== 1) return { resolution: exact.length ? "ambiguous" as const : "missing" as const };
  return { resolution: "resolved" as const, ...exact[0]! };
}
