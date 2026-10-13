import { rename, unlink } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import type { ToolResult } from "./domain/result.js";
import { assertClean, assertStateIgnored, bindWorktree, type WorktreeBinding } from "./git/index.js";
import { readGit } from "./git/command.js";
import { hasCode, ProjectFiles } from "./storage/project-files.js";
import { TaskStore } from "./storage/task-store.js";

export const ProjectPrepareInputSchema = z.object({ apply: z.boolean().default(false) }).strict();

async function optionalText(files: ProjectFiles, name: string): Promise<string | undefined> {
  try { return await files.read(name, 65_536); } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function ignoreLocalState(binding: WorktreeBinding): Promise<void> {
  const files = new ProjectFiles(binding.repo_identity);
  const target = "info/exclude";
  const lock = `${target}.lock`;
  // Preflight the existing file and use Git's conventional lock, leaving others' locks intact.
  await optionalText(files, target);
  try { await files.create(lock, ""); } catch (error) {
    if (error instanceof AppError && error.code === "FILE_EXISTS") throw new AppError("GIT_EXCLUDE_BUSY", "Git exclude.lock already exists; inspect it before retrying");
    throw error;
  }
  let ownLock = true;
  try {
    const before = await optionalText(files, target);
    const after = `${before ?? ""}${before && !before.endsWith("\n") ? "\n" : ""}# project-dev-agent local task records\n/.project-dev/local/\n`;
    await files.replace(lock, after, "");
    if ((await bindWorktree(binding.root)).repo_identity !== binding.repo_identity) throw new AppError("REPOSITORY_CHANGED", "Git identity changed during preparation");
    if (await optionalText(files, target) !== before) throw new AppError("FILE_CHANGED", "Git exclude changed during preparation");
    await rename(await files.path(lock), await files.path(target, true));
    ownLock = false;
  } finally {
    if (ownLock) await unlink(await files.path(lock));
  }
}

export async function prepareProject(binding: WorktreeBinding, input: unknown): Promise<ToolResult> {
  const { apply } = ProjectPrepareInputSchema.parse(input);
  await new ProjectFiles(binding.root).path(".project-dev/local", true);
  const tracked = await readGit(binding.root, ["ls-files", "-z", "--", ".project-dev/local"]);
  if (tracked.stdout.length) throw new AppError("STATE_ALREADY_TRACKED", "Local task state is tracked by Git; review it before preparing the project");
  let ignored = true;
  try { await assertStateIgnored(binding); } catch (error) {
    if (!(error instanceof AppError && error.code === "STATE_DIRECTORY_NOT_IGNORED")) throw error;
    ignored = false;
  }
  const changeNeeded = !ignored;
  if (apply && changeNeeded) {
    await ignoreLocalState(binding);
    await assertStateIgnored(binding);
    ignored = true;
  }
  let clean = true;
  try { await assertClean(binding); } catch (error) {
    if (!(error instanceof AppError && error.code === "WORKTREE_DIRTY")) throw error;
    clean = false;
  }
  const active = await new TaskStore(binding.root).active();
  return { outcome: "ok", code: "PROJECT_STATUS", data: {
    project: binding.root, applied: apply, state_ignored: ignored, worktree_clean: clean,
    ready_to_open: ignored && clean && !active,
    active_task: active ? { id: active.id, revision: active.revision, requirement: active.requirement } : null,
    local_ignore_change: changeNeeded ? { file: `${binding.repo_identity}/info/exclude`, action: apply ? "appended" : "would_append" } : null,
    next_step: active ? "Call task_check without task_id to recover the active task before continuing."
      : !clean ? "Keep existing changes. Let the developer choose when to commit or use a clean worktree; never auto-stash/reset/commit."
      : !ignored ? "Call project_prepare with apply: true to ignore local state, then task_open."
      : "Read existing instructions and related code, then open the requested task. An empty knowledge library is normal on first use.",
  }, diagnostics: [] };
}
