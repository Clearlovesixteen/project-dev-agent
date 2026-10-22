const COMMON = new Set(["return", "const", "function", "export", "import", "from", "default", "true", "false", "null", "undefined", "string", "number", "boolean", "async", "await", "class", "interface", "type", "status", "state", "value", "data", "props", "result", "length", "console", "this", "throw", "Error"]);
/** 静态标识符仅提供跨文件检索线索，不解析运行时绑定或把同名变量认定为同一业务对象。 */
export function lexicalReferences(text: string) {
  const clean = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  const identifiers = [...new Set(clean.match(/\b[A-Za-z_$][\w$]{3,95}\b/g) ?? [])].filter(name => !COMMON.has(name));
  const symbols = [...new Set([...clean.matchAll(/\b(?:export\s+(?:default\s+)?)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]{3,95})/g)].map(match => match[1]!))].filter(name => !COMMON.has(name));
  return { symbols: symbols.slice(0, 40), identifiers: identifiers.slice(0, 160), identifiers_truncated: identifiers.length > 160 || symbols.length > 40 };
}
