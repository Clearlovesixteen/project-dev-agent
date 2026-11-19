import { resolve, win32 } from "node:path";
import type { NativeHookInput } from "./contracts.js";
import { classifyCommand, shellDialect, singleCommand, type CommandDecision } from "./shell-policy.js";
import { shellSyntax } from "./shell-syntax.js";
import { programName } from "./shell-commands.js";

const PROJECT_TOOLS = new Set(["project_prepare", "project_scan", "project_context", "knowledge_search", "task_open", "task_update", "task_check",
  "project_feedback_record", "experience_propose", "history_scan", "history_next", "history_record", "project_model_record", "project_model_apply"]);

/** 只识别本插件固定 server 名，不改写其他 MCP 的参数或身份。 */
export function projectTool(name: string | undefined): string | undefined {
  const match = /^mcp__project_dev__(\w+)$/.exec(name ?? "");
  return match && PROJECT_TOOLS.has(match[1]!) ? match[1] : undefined;
}

export function toolArguments(input: NativeHookInput): Record<string, unknown> | undefined {
  return input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
    ? input.tool_input as Record<string, unknown> : undefined;
}

/** 正式 CLI 仍经过同一个 MCP 注册与项目边界，不能被自己的修改检查锁死。 */
function pluginCommand(args: string[] | undefined, cwd: string, root: string): boolean {
  if (!args || programName(args[0] ?? "") !== "node" || !args[1]) return false;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root);
  const target = windows ? win32.resolve(cwd, args[1]).toLowerCase() : resolve(cwd, args[1]);
  const expected = windows ? win32.resolve(root, "runtime/cli.mjs").toLowerCase() : resolve(root, "runtime/cli.mjs");
  if (target !== expected) return false;
  const action = `${args[2]} ${args[3]}`;
  return ["tools preflight", "tools call", "runtime status", "runtime configure", "plugin status", "plugin configure",
    "insights issues", "insights trace", "insights report", "baseline read"].includes(action) || args[2] === "doctor";
}

/** 按宿主实际 shell 与参数语法判定；未知不等于已确认写入，也不直接得到读取豁免。 */
export function toolCommandDecision(input: NativeHookInput, pluginRoot?: string): CommandDecision | undefined {
  if (!["Bash", "exec_command", "shell_command", "shell"].includes(input.tool_name ?? "")) return undefined;
  const args = toolArguments(input), command = args?.command ?? args?.cmd;
  const dialect = shellDialect(input.cwd, args?.shell), classified = classifyCommand(command, dialect);
  if (pluginRoot && pluginCommand(singleCommand(command, dialect), input.cwd, pluginRoot))
    return { classification: "management", reason: "COMMAND_MANAGEMENT_PLUGIN_CLI", dialect };
  return classified;
}

/** 工具可以在另一个目录执行。相对路径按工具目录解释，缺省才用聊天目录。 */
export function toolWorkingDirectory(input: NativeHookInput): string {
  if (!["Bash", "exec_command", "shell_command", "shell", "apply_patch", "Edit", "Write"].includes(input.tool_name ?? "")) return input.cwd;
  const args = toolArguments(input), directory = args?.workdir ?? args?.cwd;
  return typeof directory === "string" ? resolve(input.cwd, directory) : input.cwd;
}

export function writeKind(input: NativeHookInput, pluginRoot?: string): "patch" | "shell" | undefined {
  if (["apply_patch", "Edit", "Write"].includes(input.tool_name ?? "")) return "patch";
  const decision = toolCommandDecision(input, pluginRoot);
  if (decision) return ["read_only", "management"].includes(decision.classification) ? undefined : "shell";
  return undefined;
}

export function patchPaths(input: NativeHookInput): string[] {
  const args = toolArguments(input);
  if (["Edit", "Write"].includes(input.tool_name ?? "") && typeof args?.file_path === "string" && args.file_path.length)
    return [args.file_path];
  const patch = args?.command ?? args?.patch ?? (typeof input.tool_input === "string" ? input.tool_input : undefined);
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\r\n]+)\r?$/gm)].map(match => match[1]!);
}

/**
 * 提取少量可以静态确认的 shell 写入目标。
 * 返回 null 表示命令本身是 Git 状态操作，不直接写业务文件，返回 undefined 表示不能安全确定目标。
 */
export function shellWritePaths(input: NativeHookInput): string[] | null | undefined {
  const args = toolArguments(input), command = args?.command ?? args?.cmd;
  const decision = toolCommandDecision(input);
  if (decision?.classification !== "write" || typeof command !== "string") return undefined;
  const syntax = shellSyntax(command, decision.dialect);
  if (syntax.state === "unknown") return undefined;
  const segments: string[][] = [];
  let words: string[] = [];
  for (const token of syntax.tokens) {
    if (token.kind === "word") words.push(token.word.value);
    else if (words.length) { segments.push(words); words = []; }
  }
  if (words.length) segments.push(words);
  const paths: string[] = [];
  let sawGit = false;
  for (const segment of segments) {
    const name = programName(segment[0] ?? "");
    if (name === "git") { sawGit = true; continue; }
    if (["cp", "mv", "copy-item", "move-item"].includes(name)) {
      const values = segment.slice(1).filter(value => !value.startsWith("-"));
      if (values.length < 2) return undefined;
      paths.push(values.at(-1)!);
      continue;
    }
    if (["rm", "rmdir", "touch", "mkdir", "tee", "set-content", "add-content", "out-file", "remove-item", "new-item", "rename-item", "set-item", "clear-content"].includes(name)) {
      const values = segment.slice(1).filter(value => !value.startsWith("-"));
      if (!values.length) return undefined;
      paths.push(...(name === "tee" ? values.slice(-1) : values));
      continue;
    }
    if (name === "sed") {
      const values = segment.slice(1), script = values.findIndex(value => !value.startsWith("-"));
      if (script < 0 || values.length <= script + 1) return undefined;
      paths.push(...values.slice(script + 1));
      continue;
    }
    return undefined;
  }
  return paths.length ? paths : sawGit ? null : undefined;
}
