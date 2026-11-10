import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AppError } from "../domain/error.js";
import { gitLine, readGit } from "../git/command.js";

/** 只发现当前工作树；非 Git 会话正常退出，其他 Git 错误仍按故障处理。 */
export async function hookProject(cwd: string) {
  if (!isAbsolute(cwd)) throw new AppError("INVALID_CWD", "钩子工作目录须为绝对路径");
  let directory: string;
  try { directory = await realpath(cwd); }
  catch { throw new AppError("HOOK_CWD_UNAVAILABLE", "当前会话目录不可读取"); }
  const result = await readGit(directory, ["rev-parse", "--show-toplevel"], [128]);
  if (result.exitCode !== 0) {
    // readGit 固定 LC_ALL=C。不能将权限、仓库损坏等所有 exit 128 都隐藏成正常跳过。
    if (/^fatal: not a git repository(?:\s|:|$)/m.test(result.stderr?.toString("utf8") ?? ""))
      throw new AppError("NOT_GIT_WORKTREE", "当前会话不在 Git 项目中");
    throw new AppError("GIT_COMMAND_FAILED", "无法发现当前 Git 工作树");
  }
  return realpath(gitLine(result.stdout));
}

export type HookStage = "runtime" | "scope" | "task" | "context" | "receipt" | "guard";
const SAFE_REASONS = new Set(["INVALID_CWD", "HOOK_CWD_UNAVAILABLE", "NOT_GIT_WORKTREE", "PROJECT_OUTSIDE_WORKSPACE",
  "PROJECT_PATH_UNSAFE", "PLUGIN_NOT_CONFIGURED", "PLUGIN_SETTINGS_INVALID", "WORKSPACE_CHANGED", "WORKSPACE_PATH_INVALID",
  "GIT_COMMAND_FAILED", "GIT_OUTPUT_INVALID", "RUNTIME_CONFIG_INVALID", "CONTEXT_RECEIPT_BUSY", "STATE_CORRUPT",
  "INVALID_TASK", "MULTIPLE_ACTIVE_TASKS", "STATE_LIMIT", "PARTICIPATION_BUSY"]);

/** 固定白名单及阶段兜底；绝不把错误 message、路径或任意外部 code 当作遥测内容。 */
export function hookFailure(error: unknown, stage: HookStage) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const reason = typeof code === "string" && SAFE_REASONS.has(code) ? code : {
    runtime: "HOOK_RUNTIME_FAILED", scope: "HOOK_SCOPE_FAILED", task: "HOOK_TASK_LOOKUP_FAILED",
    context: "HOOK_CONTEXT_LOOKUP_FAILED", receipt: "HOOK_RECEIPT_FAILED", guard: "HOOK_WRITE_CHECK_FAILED",
  }[stage];
  return { outcome: reason === "NOT_GIT_WORKTREE" || reason === "PROJECT_OUTSIDE_WORKSPACE" ? "skipped" as const : "degraded" as const, reason };
}
