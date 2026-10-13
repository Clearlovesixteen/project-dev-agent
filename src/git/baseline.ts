import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AppError } from "../domain/error.js";
import type { Task } from "../domain/task.js";
import { assertObjectId, gitLine, readGit } from "./command.js";

export interface WorktreeBinding {
  root: string;
  repo_identity: string;
  head: string;
  branch: string | null;
}

async function currentBranch(root: string): Promise<string | null> {
  const result = await readGit(root, ["symbolic-ref", "--quiet", "HEAD"], [1]);
  if (result.exitCode === 1) return null;
  const reference = gitLine(result.stdout);
  if (!reference.startsWith("refs/heads/")) {
    throw new AppError("GIT_OUTPUT_INVALID", "HEAD does not reference a local branch");
  }
  return reference.slice("refs/heads/".length);
}

export async function bindWorktree(project: string): Promise<WorktreeBinding> {
  if (!isAbsolute(project)) throw new AppError("PROJECT_PATH_INVALID", "The worktree path must be absolute");
  let root: string;
  try {
    root = await realpath(project);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AppError("PROJECT_PATH_INVALID", "The worktree path must be an existing directory");
  }

  let topLevel: string;
  let commonDirectory: string;
  try {
    const inside = await readGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (gitLine(inside.stdout) !== "true") throw new Error("not a worktree");
    topLevel = await realpath(gitLine((await readGit(root, ["rev-parse", "--show-toplevel"])).stdout));
    commonDirectory = await realpath(gitLine((await readGit(root, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ])).stdout));
  } catch {
    throw new AppError("NOT_GIT_WORKTREE", "The project must be a Git working tree");
  }
  if (root !== topLevel) {
    throw new AppError("WORKTREE_ROOT_REQUIRED", "Bind the worktree root, not a directory inside it");
  }

  let head: string;
  try {
    head = gitLine((await readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout);
    assertObjectId(head);
  } catch {
    throw new AppError("NO_COMMITS", "The worktree must have an initial commit");
  }
  return { root, repo_identity: commonDirectory, head, branch: await currentBranch(root) };
}

export async function assertClean(binding: WorktreeBinding): Promise<void> {
  const result = await readGit(binding.root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none",
  ]);
  if (result.stdout.length !== 0) {
    throw new AppError("WORKTREE_DIRTY", "Create tasks from a worktree without staged, unstaged or untracked changes");
  }
}

export async function assertStateIgnored(binding: WorktreeBinding): Promise<void> {
  const result = await readGit(binding.root, [
    "check-ignore", "--quiet", "--", ".project-dev/local/tasks/probe.json",
  ], [1]);
  if (result.exitCode !== 0) {
    throw new AppError("STATE_DIRECTORY_NOT_IGNORED", "Ignore .project-dev/local/ before creating task state");
  }
}

export async function assertBaseline(binding: WorktreeBinding, task: Task): Promise<void> {
  const current = await bindWorktree(binding.root);
  if (task.worktree_path !== binding.root || task.repo_identity !== binding.repo_identity
    || current.root !== binding.root || current.repo_identity !== binding.repo_identity) {
    throw new AppError("TASK_BINDING_MISMATCH", "The task belongs to a different repository or worktree");
  }
  if (current.branch !== task.baseline_branch) {
    throw new AppError("BASELINE_BRANCH_CHANGED", "The current branch differs from the task's starting branch");
  }
  assertObjectId(task.baseline_head);
  let result;
  try {
    result = await readGit(binding.root, [
      "merge-base", "--is-ancestor", task.baseline_head, current.head,
    ], [1]);
  } catch {
    throw new AppError("BASELINE_UNAVAILABLE", "The starting commit is unavailable in the bound repository");
  }
  if (result.exitCode !== 0) {
    throw new AppError("BASELINE_NOT_REACHABLE", "The starting commit is no longer an ancestor of the current commit");
  }
}
