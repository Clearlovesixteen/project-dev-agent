/** 屏蔽字符串和注释但保持位置，用于避免把示例文案当成实际 HTTP 调用；不替代 AST。 */
export function codeMask(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    value => value.replace(/[^\n]/g, " "));
}
export const HTTP_LIBRARIES = new Set(["axios", "ky", "ofetch", "node-fetch", "cross-fetch", "got", "superagent", "undici"]);

/** 统计明确的底层 HTTP 入口；忽略类型导入，保留动作以识别新增 create 与直接调用。 */
export function httpUsage(text: string): Map<string, number> {
  const code = codeMask(text), aliases = new Map<string, string>(), localFetch = new Set<string>();
  const imports = /\bimport\s+([^;\n]+?)\s+from\s*['"]([^'"]+)['"]|\b(?:const|let)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(imports)) {
    if (!/\b(?:import|const|let)\b/.test(code.slice(match.index, match.index + 7))) continue;
    const library = match[2] ?? match[4]!;
    if (!HTTP_LIBRARIES.has(library)) {
      const clause = match[1] ?? "";
      if (/^fetch(?:\s*,|$)|\b(?:as\s+fetch|fetch(?:\s*[,}]|$))/.test(clause)) localFetch.add("fetch");
      continue;
    }
    if (match[3]) { aliases.set(match[3], library); continue; }
    const clause = match[1]!.trim(); if (clause.startsWith("type ")) continue;
    const defaultName = /^(\w+)(?:\s*,|$)/.exec(clause)?.[1] ?? /^\*\s+as\s+(\w+)/.exec(clause)?.[1];
    if (defaultName) aliases.set(defaultName, library);
    for (const item of (/{([^}]+)}/.exec(clause)?.[1] ?? "").split(",")) {
      const named = /^\s*(create|request|fetch|\$fetch|ofetch|Axios)\s*(?:as\s+(\w+))?\s*$/.exec(item);
      if (named) aliases.set(named[2] ?? named[1]!, library);
    }
  }
  const usage = new Map<string, number>();
  const add = (key: string) => usage.set(key, (usage.get(key) ?? 0) + 1);
  for (const [name, library] of aliases) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of code.matchAll(new RegExp(`(?<![\\w$.])(?:new\\s+)?${escaped}\\s*(?:\\.\\s*(create|get|post|put|patch|delete|request|head|options|extend))?\\s*\\(`, "g"))) add(`${library}:${match[1] ?? "call"}`);
  }
  if (!aliases.has("fetch") && !localFetch.has("fetch") && !/\b(?:const|let|function)\s+fetch\b/.test(code)) {
    for (const _match of code.matchAll(/(?<![\w$.])fetch\s*\(/g)) add("fetch:call");
  }
  for (const _match of code.matchAll(/\b(?:globalThis|window|self)\s*\.\s*fetch\s*\(/g)) add("fetch:call");
  for (const _match of code.matchAll(/\bnew\s+XMLHttpRequest\s*\(/g)) add("xhr:new");
  return usage;
}
