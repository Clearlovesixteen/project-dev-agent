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
    throw new AppError("GIT_OUTPUT_INVALID", "HEAD 未指向本地分支");
  }
  return reference.slice("refs/heads/".length);
}

export async function bindWorktree(project: string): Promise<WorktreeBinding> {
  if (!isAbsolute(project)) throw new AppError("PROJECT_PATH_INVALID", "工作树路径必须是绝对路径");
  let root: string;
  try {
    root = await realpath(project);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AppError("PROJECT_PATH_INVALID", "工作树路径必须指向已存在的目录");
  }

  let topLevel: string;
  let commonDirectory: string;
  try {
    const inside = await readGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (gitLine(inside.stdout) !== "true") throw new Error("不是 Git 工作树");
    topLevel = await realpath(gitLine((await readGit(root, ["rev-parse", "--show-toplevel"])).stdout));
    commonDirectory = await realpath(gitLine((await readGit(root, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ])).stdout));
  } catch {
    throw new AppError("NOT_GIT_WORKTREE", "项目必须是 Git 工作树");
  }
  if (root !== topLevel) {
    throw new AppError("WORKTREE_ROOT_REQUIRED", "请指定 Git 工作树的根目录，不能使用其内部子目录");
  }

  let head: string;
  try {
    head = gitLine((await readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout);
    assertObjectId(head);
  } catch {
    throw new AppError("NO_COMMITS", "工作树需要先有一次初始提交");
  }
  return { root, repo_identity: commonDirectory, head, branch: await currentBranch(root) };
}

export async function assertClean(binding: WorktreeBinding): Promise<void> {
  const result = await readGit(binding.root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none",
  ]);
  if (result.stdout.length !== 0) {
    throw new AppError("WORKTREE_DIRTY", "创建任务前，工作树不能包含已暂存、未暂存或未跟踪的改动");
  }
}

export async function assertStateIgnored(binding: WorktreeBinding): Promise<void> {
  const result = await readGit(binding.root, [
    "check-ignore", "--quiet", "--", ".project-dev/local/tasks/probe.json",
  ], [1]);
  if (result.exitCode !== 0) {
    throw new AppError("STATE_DIRECTORY_NOT_IGNORED", "创建任务记录前，请先将 .project-dev/local/ 加入 Git 忽略规则");
  }
}

export async function assertBaseline(binding: WorktreeBinding, task: Task): Promise<void> {
  const current = await bindWorktree(binding.root);
  if (task.worktree_path !== binding.root || task.repo_identity !== binding.repo_identity
    || current.root !== binding.root || current.repo_identity !== binding.repo_identity) {
    throw new AppError("TASK_BINDING_MISMATCH", "该任务属于其他仓库或工作树");
  }
  if (current.branch !== task.baseline_branch) {
    throw new AppError("BASELINE_BRANCH_CHANGED", "当前分支与任务开始时的分支不同");
  }
  assertObjectId(task.baseline_head);
  let result;
  try {
    result = await readGit(binding.root, [
      "merge-base", "--is-ancestor", task.baseline_head, current.head,
    ], [1]);
  } catch {
    throw new AppError("BASELINE_UNAVAILABLE", "当前仓库中无法读取任务开始时的提交");
  }
  if (result.exitCode !== 0) {
    throw new AppError("BASELINE_NOT_REACHABLE", "任务开始时的提交已不在当前提交的祖先链中");
  }
}
