import { historyFreshness } from "./history/freshness.js";
import { HistoryService } from "./history/service.js";
import { rename, unlink } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import type { ToolResult } from "./domain/result.js";
import {
  assertClean,
  assertStateIgnored,
  bindWorktree,
  type WorktreeBinding,
} from "./git/index.js";
import { readGit } from "./git/command.js";
import { hasCode, ProjectFiles } from "./storage/project-files.js";
import { TaskStore } from "./storage/task-store.js";
import { historyStatus } from "./history/store.js";
import { understandingStatus } from "./understanding/store.js";

export const ProjectPrepareInputSchema = z
  .object({ apply: z.boolean().default(false) })
  .strict();

async function optionalText(
  files: ProjectFiles,
  name: string,
): Promise<string | undefined> {
  try {
    return await files.read(name, 65_536);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** 把个人状态加入 Git 本地忽略文件，避免为个人接入修改团队共享的 .gitignore。 */
async function ignoreLocalState(binding: WorktreeBinding): Promise<void> {
  const files = new ProjectFiles(binding.repo_identity);
  const target = "info/exclude";
  const lock = `${target}.lock`;
  // 预检文件并使用 Git 约定的锁文件；其他进程持有的锁必须保留。
  await optionalText(files, target);
  try {
    await files.create(lock, "");
  } catch (error) {
    if (error instanceof AppError && error.code === "FILE_EXISTS")
      throw new AppError(
        "GIT_EXCLUDE_BUSY",
        "Git exclude.lock 已存在，请核对锁状态后再重试",
      );
    throw error;
  }
  let ownLock = true;
  try {
    const before = await optionalText(files, target);
    const after = `${before ?? ""}${
      before && !before.endsWith("\n") ? "\n" : ""
    }# project-dev-agent 本地任务记录\n/.project-dev/local/\n`;
    await files.replace(lock, after, "");
    if (
      (await bindWorktree(binding.root)).repo_identity !== binding.repo_identity
    )
      throw new AppError(
        "REPOSITORY_CHANGED",
        "准备过程中 Git 仓库标识发生变化",
      );
    if ((await optionalText(files, target)) !== before)
      throw new AppError("FILE_CHANGED", "准备过程中 Git 本地忽略规则发生变化");
    // 完整内容先写入锁文件，再重命名发布，避免留下写了一半的忽略规则。
    await rename(await files.path(lock), await files.path(target, true));
    ownLock = false;
  } finally {
    if (ownLock) await unlink(await files.path(lock));
  }
}

/**
 * 汇总项目是否可以建任务，以及已有任务、历史和结构索引状态。
 * apply 只补充本地忽略规则；准备过程不会整理、提交或丢弃已有业务改动。
 */
export async function prepareProject(
  binding: WorktreeBinding,
  input: unknown,
): Promise<ToolResult> {
  const { apply } = ProjectPrepareInputSchema.parse(input);
  await new ProjectFiles(binding.root).path(".project-dev/local", true);
  // 已被跟踪的文件不会因新增 ignore 规则而退出版本管理，需要先显式处理。
  const tracked = await readGit(binding.root, [
    "ls-files",
    "-z",
    "--",
    ".project-dev/local",
  ]);
  if (tracked.stdout.length)
    throw new AppError(
      "STATE_ALREADY_TRACKED",
      "本地任务记录已被 Git 跟踪，请检查后再准备项目",
    );
  let ignored = true;
  try {
    await assertStateIgnored(binding);
  } catch (error) {
    if (
      !(
        error instanceof AppError &&
        error.code === "STATE_DIRECTORY_NOT_IGNORED"
      )
    )
      throw error;
    ignored = false;
  }
  const changeNeeded = !ignored;
  if (apply && changeNeeded) {
    await ignoreLocalState(binding);
    await assertStateIgnored(binding);
    ignored = true;
  }
  let clean = true;
  try {
    await assertClean(binding);
  } catch (error) {
    if (!(error instanceof AppError && error.code === "WORKTREE_DIRTY"))
      throw error;
    clean = false;
  }
  const active = await new TaskStore(binding.root).active();
  const unmerged =
    (await readGit(binding.root, ["ls-files", "--unmerged", "-z"])).stdout
      .length > 0;
  // 历史或结构索引损坏时返回各自的 unavailable 状态，仍提供任务恢复信息。
  let history: unknown;
  let history_freshness: unknown;
  try {
    const files = new ProjectFiles(binding.root),
      freshness = await historyFreshness(files);
    if (
      apply &&
      ignored &&
      freshness.needs_refresh &&
      freshness.state !== "not_scanned"
    ) {
      const refreshed = await new HistoryService(binding).scan({});
      history_freshness = { ...freshness, refresh_result: refreshed.code };
    } else history_freshness = freshness;
    history = await historyStatus(files);
  } catch (error) {
    history = {
      state: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let understanding: unknown;
  try {
    understanding = await understandingStatus(new ProjectFiles(binding.root));
  } catch (error) {
    understanding = {
      state: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    outcome: "ok",
    code: "PROJECT_STATUS",
    data: {
      project: binding.root,
      applied: apply,
      state_ignored: ignored,
      worktree_clean: clean,
      ready_to_open: ignored && !active && !unmerged,
      unmerged,
      history,
      history_freshness,
      understanding,
      active_task: active
        ? {
            id: active.id,
            revision: active.revision,
            requirement: active.requirement,
          }
        : null,
      local_ignore_change: changeNeeded
        ? {
            file: `${binding.repo_identity}/info/exclude`,
            action: apply ? "appended" : "would_append",
          }
        : null,
      next_step: active
        ? "继续前请调用不带 task_id 的 task_check，恢复当前活跃任务。"
        : unmerged
        ? "先解决当前Git合并冲突，已有普通改动会保留。"
        : !clean && ignored
        ? "当前已有改动，task_open 会保存接入内容基线；继续开发时保留现有工作，不自动 stash、reset 或 commit。"
        : !ignored
        ? "调用 project_prepare 并传 apply: true，准备本地忽略规则后再调用 task_open。"
        : "阅读现有指令和相关代码，再建立本次任务。首次使用时知识库为空是正常情况。",
    },
    diagnostics: [],
  };
}
