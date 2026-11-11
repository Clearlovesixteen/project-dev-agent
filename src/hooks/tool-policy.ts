import { resolve, win32 } from "node:path";
import type { NativeHookInput } from "./contracts.js";
import { classifyCommand, shellDialect, singleCommand, type CommandDecision } from "./shell-policy.js";
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

/** 终端可能在另一个工作目录执行；用实际工具目录找项目，避免把临时检查归到聊天目录。 */
export function toolWorkingDirectory(input: NativeHookInput): string {
  if (!["Bash", "exec_command", "shell_command", "shell"].includes(input.tool_name ?? "")) return input.cwd;
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
  const args = toolArguments(input), patch = args?.command ?? args?.patch ?? (typeof input.tool_input === "string" ? input.tool_input : undefined);
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]!);
}
