import { basename, resolve } from "node:path";
import type { NativeHookInput } from "./contracts.js";

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

/** 仅解析没有替换、重定向和控制操作的单条命令；不尝试模拟 shell。 */
function simpleArguments(command: unknown): string[] | undefined {
  if (typeof command !== "string" || !command.trim() || /[;&|<>`$\n\r]/.test(command)) return undefined;
  const tokens = command.match(/"[^"\\]*"|'[^']*'|[^\s"']+/g);
  if (!tokens?.length || tokens.join(" ").replace(/\s/g, "") !== command.trim().replace(/\s/g, "")) return undefined;
  return tokens.map(token => token.replace(/^(['"])(.*)\1$/, "$2"));
}

/** 正式 CLI 仍经过同一个 MCP 注册与项目边界，不能被自己的修改检查锁死。 */
function pluginCommand(command: unknown, cwd: string, root: string): boolean {
  const args = simpleArguments(command);
  if (!args || basename(args[0]!) !== "node" || !args[1] || resolve(cwd, args[1]) !== resolve(root, "runtime/cli.mjs")) return false;
  const action = `${args[2]} ${args[3]}`;
  return ["tools preflight", "tools call", "runtime status", "runtime configure", "plugin status", "plugin configure",
    "insights issues", "insights trace", "insights report", "baseline read"].includes(action) || args[2] === "doctor";
}

/**
 * 只放行可直接辨认的只读 shell 形式。复合命令、解释器及未知程序先准备任务；
 * 这用于开发流程检查，不是 shell 安全沙箱，也不声称推导出任意脚本的修改路径。
 */
function readOnlyCommand(command: unknown): boolean {
  const args = simpleArguments(command);
  if (!args) return false;
  const executable = basename(args[0]!);
  // 插件安装/更新管理与工作区切换有自己的授权流程，不强制创建无关开发任务。
  if (["codex", "codex-cli"].includes(executable)) {
    let index = 1;
    while (["-c", "--config", "-p", "--profile"].includes(args[index] ?? "")) index += 2;
    if (args[index] === "plugin" || args[index] === "--version") return true;
  }
  if (["node", "npm", "pnpm", "yarn", "git"].includes(executable) && ["--version", "-v"].includes(args[1] ?? "")) return true;
  if (["pwd", "ls", "cat", "head", "tail", "wc", "stat", "file", "readlink", "realpath", "rg", "grep"].includes(executable))
    return !args.some(arg => /^(?:--pre|--pre-glob|--hostname-bin)(?:=|$)/.test(arg));
  if (["shasum", "sha256sum", "md5", "md5sum"].includes(executable)) return true;
  if (executable === "sed") {
    const rest = args.slice(1);
    if (rest[0] === "-n") rest.shift();
    return /^\d+(?:,\d+)?p$/.test(rest[0] ?? "") && rest.length >= 2 && rest.slice(1).every(arg => !arg.startsWith("-"));
  }
  if (executable === "git" && ["fetch", "pull", "switch", "worktree"].includes(args[1] ?? "")) return true;
  if (executable === "git" && args[1] === "checkout" && ["-b", "-B"].includes(args[2] ?? "")) return true;
  if (executable === "git") return ["status", "diff", "show", "log", "ls-files", "rev-parse", "branch", "check-ignore"].includes(args[1] ?? "")
    && !(args[1] === "branch" && args.slice(2).some(arg => !["--show-current", "--list", "-a", "-r"].includes(arg)))
    && !args.some(arg => /^(?:--output|--ext-diff|--textconv|--no-index|--exec)(?:=|$)/.test(arg));
  return false;
}

/** 终端可能在另一个工作目录执行；用实际工具目录找项目，避免把临时检查归到聊天目录。 */
export function toolWorkingDirectory(input: NativeHookInput): string {
  if (!["Bash", "exec_command", "shell_command", "shell"].includes(input.tool_name ?? "")) return input.cwd;
  const args = toolArguments(input), directory = args?.workdir ?? args?.cwd;
  return typeof directory === "string" ? resolve(input.cwd, directory) : input.cwd;
}

export function writeKind(input: NativeHookInput, pluginRoot?: string): "patch" | "shell" | undefined {
  if (["apply_patch", "Edit", "Write"].includes(input.tool_name ?? "")) return "patch";
  if (["Bash", "exec_command", "shell_command", "shell"].includes(input.tool_name ?? "")) {
    const args = toolArguments(input);
    const command = args?.command ?? args?.cmd;
    return readOnlyCommand(command) || pluginRoot && pluginCommand(command, input.cwd, pluginRoot) ? undefined : "shell";
  }
  return undefined;
}

export function patchPaths(input: NativeHookInput): string[] {
  const args = toolArguments(input), patch = args?.command ?? args?.patch ?? (typeof input.tool_input === "string" ? input.tool_input : undefined);
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]!);
}
