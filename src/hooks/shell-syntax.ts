/** 只做有界静态词法分析；不展开变量、不执行命令，也不把未知脚本当作只读。 */
export type ShellDialect = "posix" | "powershell" | "cmd";
export type ShellWord = { value: string; quoted: boolean };
export type ShellToken = { kind: "word"; word: ShellWord } | { kind: "operator"; value: string };
export type ShellSyntax = { state: "parsed"; tokens: ShellToken[] } | { state: "unknown"; reason: "LIMIT" | "DYNAMIC" | "SYNTAX" };

function expansion(text: string, index: number, dialect: ShellDialect) {
  if (dialect === "cmd") return text[index] === "%" || text[index] === "!";
  return dialect === "powershell" && text[index] === "@" && /[\w{(]/.test(text[index + 1] ?? "")
    || text[index] === "$" && /[\w{(]/.test(text[index + 1] ?? "")
    || dialect === "posix" && text[index] === "$" && /[@*#?$!\-]/.test(text[index + 1] ?? "");
}

export function shellSyntax(command: string, dialect: ShellDialect): ShellSyntax {
  if (!command.trim() || command.length > 65_536) return { state: "unknown", reason: "LIMIT" };
  const tokens: ShellToken[] = [];
  let value = "", quote = "", quoted = false, present = false;
  const flush = () => { if (present) tokens.push({ kind: "word", word: { value, quoted } }); value = ""; quoted = false; present = false; };
  for (let index = 0; index < command.length; index++) {
    if (tokens.length > 512) return { state: "unknown", reason: "LIMIT" };
    const char = command[index]!, next = command[index + 1];
    if (quote === "'") {
      if (char === "'" && dialect === "powershell" && next === "'") { value += "'"; index++; }
      else if (char === "'") quote = "";
      else value += char;
      continue;
    }
    // PowerShell 用反引号转义，Posix 用反斜线；Windows 路径中的反斜线不是转义。
    const escaped = dialect === "powershell" && char === "`" || dialect === "cmd" && char === "^"
      || dialect === "posix" && char === "\\" && (!quote || next !== undefined && /["\\$`\n\r]/.test(next));
    if (escaped) {
      if (next === undefined) return { state: "unknown", reason: "SYNTAX" };
      if (next !== "\n" && next !== "\r") { value += next; present = true; }
      index++; continue;
    }
    if (dialect === "posix" && char === "`" || expansion(command, index, dialect)) return { state: "unknown", reason: "DYNAMIC" };
    if (quote === '"') {
      if (char === '"') quote = ""; else value += char;
      continue;
    }
    if (char === '"' || char === "'" && dialect !== "cmd") { quote = char; quoted = true; present = true; continue; }
    if (char === "#" && !present && dialect !== "cmd") {
      while (index < command.length && !/[\r\n]/.test(command[index]!)) index++;
      index--; continue;
    }
    if (/[\r\n]/.test(char)) { flush(); if (tokens.length && tokens.at(-1)?.kind !== "operator") tokens.push({ kind: "operator", value: ";" }); continue; }
    if (/[ \t]/.test(char)) { flush(); continue; }
    if (/[(){}]/.test(char)) return { state: "unknown", reason: "SYNTAX" };
    if (/[;&|<>]/.test(char)) {
      flush();
      const operator = next === char && char !== ";" ? char + next : char;
      if (operator.length === 2) index++;
      tokens.push({ kind: "operator", value: operator }); continue;
    }
    if (char === "\0") return { state: "unknown", reason: "SYNTAX" };
    value += char; present = true;
  }
  if (quote) return { state: "unknown", reason: "SYNTAX" };
  flush();
  return tokens.length <= 512 ? { state: "parsed", tokens } : { state: "unknown", reason: "LIMIT" };
}
