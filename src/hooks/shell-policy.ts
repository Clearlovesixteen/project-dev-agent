import { commandCapability, programName, type CommandClass } from "./shell-commands.js";
import { shellSyntax, type ShellDialect, type ShellWord } from "./shell-syntax.js";

export type CommandDecision = { classification: CommandClass; reason: string; dialect: ShellDialect };
const decision = (classification: CommandClass, reason: string, dialect: ShellDialect): CommandDecision => ({ classification, reason, dialect });

export function shellDialect(cwd: string, shell?: unknown): ShellDialect {
  const name = typeof shell === "string" ? programName(shell) : "";
  if (["powershell", "pwsh"].includes(name)) return "powershell";
  if (name === "cmd") return "cmd";
  if (["bash", "zsh", "sh"].includes(name)) return "posix";
  return /^[a-z]:[\\/]|^\\\\/i.test(cwd) || process.platform === "win32" ? "powershell" : "posix";
}

function wrapped(words: ShellWord[], depth: number): CommandDecision | undefined {
  const name = programName(words[0]?.value ?? "");
  let dialect: ShellDialect, index = 1;
  if (["sh", "bash", "zsh"].includes(name)) {
    dialect = "posix";
    if (!["-c", "-lc"].includes(words[index]?.value ?? "")) return decision("unknown", "COMMAND_UNKNOWN_WRAPPER", dialect);
  } else if (["powershell", "pwsh"].includes(name)) {
    dialect = "powershell";
    while (["-noprofile", "-noninteractive", "-nologo"].includes(words[index]?.value.toLowerCase() ?? "")) index++;
    if (!["-command", "-c"].includes(words[index]?.value.toLowerCase() ?? "")) return decision("unknown", "COMMAND_UNKNOWN_WRAPPER", dialect);
  } else if (name === "cmd") {
    dialect = "cmd";
    if (words[index]?.value.toLowerCase() === "/d") index++;
    if (words[index]?.value.toLowerCase() !== "/c") return decision("unknown", "COMMAND_UNKNOWN_WRAPPER", dialect);
  } else return undefined;
  const body = words[index + 1];
  if (!body || words.length !== index + 2) return decision("unknown", "COMMAND_UNKNOWN_WRAPPER", dialect);
  const nested = classifyCommand(body.value, dialect, depth + 1);
  return nested.classification === "read_only" ? decision("read_only", "COMMAND_READ_ONLY_WRAPPER", dialect) : nested;
}

/** 静态读取链要求每个片段都只读；任何写入或未知片段都不能借读取前缀获得放行。 */
export function classifyCommand(command: unknown, dialect: ShellDialect, depth = 0): CommandDecision {
  if (typeof command !== "string" || depth > 3) return decision("unknown", "COMMAND_UNKNOWN_LIMIT", dialect);
  const syntax = shellSyntax(command, dialect);
  if (syntax.state === "unknown") return decision("unknown", `COMMAND_UNKNOWN_${syntax.reason}`, dialect);
  if (syntax.tokens.some(token => token.kind === "operator" && token.value.includes(">"))) return decision("write", "COMMAND_WRITE_REDIRECTION", dialect);
  const segments: ShellWord[][] = []; let current: ShellWord[] = [], invocation = false;
  for (let index = 0; index < syntax.tokens.length; index++) {
    const token = syntax.tokens[index]!;
    if (token.kind === "word") { current.push(token.word); continue; }
    if (token.value === "&" && dialect === "powershell" && !current.length && !invocation) { invocation = true; continue; }
    if (!["|", "||", "&&", ";"].includes(token.value) || !current.length) return decision("unknown", "COMMAND_UNKNOWN_SYNTAX", dialect);
    segments.push(current); current = []; invocation = false;
    if (index === syntax.tokens.length - 1 && token.value !== ";") return decision("unknown", "COMMAND_UNKNOWN_SYNTAX", dialect);
  }
  if (current.length) segments.push(current);
  if (!segments.length) return decision("unknown", "COMMAND_UNKNOWN_SYNTAX", dialect);
  const decisions = segments.map(words => wrapped(words, depth) ?? decision(commandCapability(words.map(word => word.value), dialect), "COMMAND_UNKNOWN_CAPABILITY", dialect));
  if (decisions.some(value => value.classification === "write")) return decision("write", "COMMAND_WRITE_OPERATION", dialect);
  const unknown = decisions.find(value => value.classification === "unknown");
  if (unknown) return unknown;
  if (decisions.some(value => value.classification === "management")) return segments.length === 1
    ? decision("management", "COMMAND_MANAGEMENT", dialect) : decision("unknown", "COMMAND_UNKNOWN_COMBINATION", dialect);
  const reason = segments.length > 1 ? "COMMAND_READ_ONLY_CHAIN" : decisions[0]?.reason === "COMMAND_READ_ONLY_WRAPPER" ? "COMMAND_READ_ONLY_WRAPPER"
    : dialect !== "posix" ? "COMMAND_READ_ONLY_WINDOWS" : syntax.tokens.some(token => token.kind === "word" && token.word.quoted) ? "COMMAND_READ_ONLY_QUOTED" : "COMMAND_READ_ONLY_SINGLE";
  return decision("read_only", reason, segments.length === 1 && reason === "COMMAND_READ_ONLY_WRAPPER" ? decisions[0]!.dialect : dialect);
}

/** 供固定插件 CLI 适配使用；复杂链路不能通过一个合法的前缀得到管理豁免。 */
export function singleCommand(command: unknown, dialect: ShellDialect): string[] | undefined {
  if (typeof command !== "string") return undefined;
  const syntax = shellSyntax(command, dialect);
  return syntax.state === "parsed" && syntax.tokens.every(token => token.kind === "word")
    ? syntax.tokens.map(token => (token as { kind: "word"; word: ShellWord }).word.value) : undefined;
}
