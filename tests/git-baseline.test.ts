import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AppError } from "../src/domain/error.js";
import { TaskSchema, type Task } from "../src/domain/task.js";
import {
  assertBaseline, assertClean, assertStateIgnored, bindWorktree, changedPaths, type WorktreeBinding,
} from "../src/git/index.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", [
    "-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgsign=false",
    "-c", "user.name=Git fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd });
}

function taskFor(binding: WorktreeBinding): Task {
  const now = new Date().toISOString();
  return TaskSchema.parse({
    schema_version: 1, id: "baseline-test", revision: 0,
    repo_identity: binding.repo_identity, worktree_path: binding.root,
    baseline_head: binding.head, baseline_branch: binding.branch, phase: "active",
    requirement: "Add disabled accounts", acceptance_criteria: [{ id: "account-status", description: "Status behavior is correct" }],
    created_at: now, updated_at: now,
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}

test("binding requires a committed worktree root and shares identity across linked worktrees", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  assert.equal(binding.root, fixture.path);
  assert.equal(binding.head, fixture.head);
  assert.equal(binding.branch, "main");
  await assert.rejects(bindWorktree("."), hasCode("PROJECT_PATH_INVALID"));
  await assert.rejects(bindWorktree(join(fixture.path, "src")), hasCode("WORKTREE_ROOT_REQUIRED"));
  const empty = join(fixture.root, "uncommitted");
  await mkdir(empty);
  await git(empty, ["init", "--template=", "--initial-branch=main"]);
  await assert.rejects(bindWorktree(empty), hasCode("NO_COMMITS"));
  const linked = join(fixture.root, "linked-worktree");
  await git(fixture.path, ["worktree", "add", "--detach", linked]);
  const linkedBinding = await bindWorktree(linked);
  assert.equal(linkedBinding.repo_identity, binding.repo_identity);
  assert.equal(linkedBinding.branch, null);
  assert.notEqual(linkedBinding.root, binding.root);
  await assert.rejects(assertBaseline(linkedBinding, taskFor(binding)), hasCode("TASK_BINDING_MISMATCH"));
});

test("clean checks include untracked, unstaged and staged changes while ignoring local task state", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await assertStateIgnored(binding);
  await mkdir(join(fixture.path, ".project-dev", "local", "tasks"), { recursive: true });
  await writeFile(join(fixture.path, ".project-dev", "local", "tasks", "record.json"), "{}\n");
  await assertClean(binding);
  await writeFile(join(fixture.path, "untracked.txt"), "untracked\n");
  await assert.rejects(assertClean(binding), hasCode("WORKTREE_DIRTY"));
  await rm(join(fixture.path, "untracked.txt"));
  await appendFile(join(fixture.path, "src", "service.js"), "\n// unstaged change\n");
  await assert.rejects(assertClean(binding), hasCode("WORKTREE_DIRTY"));
  await git(fixture.path, ["add", "--", "src/service.js"]);
  await assert.rejects(assertClean(binding), hasCode("WORKTREE_DIRTY"));
});

test("state directory checks reject repositories without the ignore rule", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await writeFile(join(fixture.path, ".gitignore"), "node_modules/\n");
  await assert.rejects(assertStateIgnored(binding), hasCode("STATE_DIRECTORY_NOT_IGNORED"));
});

test("normal commits keep the baseline valid, but branch changes and rewritten roots do not", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const task = taskFor(binding);
  await writeFile(join(fixture.path, "committed.txt"), "normal commit\n");
  await git(fixture.path, ["add", "--", "committed.txt"]);
  await git(fixture.path, ["commit", "-m", "Normal task commit"]);
  await assertBaseline(binding, task);
  await git(fixture.path, ["checkout", "-b", "other-branch"]);
  await assert.rejects(assertBaseline(binding, task), hasCode("BASELINE_BRANCH_CHANGED"));
  await git(fixture.path, ["checkout", "--orphan", "rewritten-root"]);
  await git(fixture.path, ["add", "--all"]);
  await git(fixture.path, ["commit", "-m", "Unrelated root"]);
  await git(fixture.path, ["branch", "-M", "main"]);
  await assert.rejects(assertBaseline(binding, task), hasCode("BASELINE_NOT_REACHABLE"));
});

test("change collection combines committed, staged, unstaged, deleted, renamed and untracked paths", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await writeFile(join(fixture.path, "committed.txt"), "new committed file\n");
  await git(fixture.path, ["add", "--", "committed.txt"]);
  await git(fixture.path, ["commit", "-m", "Task progress"]);
  await git(fixture.path, ["mv", "--", "src/view.js", "src/summary.js"]);
  await appendFile(join(fixture.path, "src", "service.js"), "\n// staged\n");
  await git(fixture.path, ["add", "--", "src/service.js"]);
  await appendFile(join(fixture.path, "src", "auth.js"), "\n// unstaged\n");
  await rm(join(fixture.path, "README.md"));
  const unusualName = "new file\nwith newline.js";
  await writeFile(join(fixture.path, unusualName), "// untracked\n");
  await mkdir(join(fixture.path, ".project-dev", "local"), { recursive: true });
  await writeFile(join(fixture.path, ".project-dev", "local", "ignored.json"), "{}\n");
  assert.deepEqual(await changedPaths(binding, fixture.head), [
    "README.md", "committed.txt", unusualName, "src/auth.js", "src/service.js", "src/summary.js", "src/view.js",
  ].sort());
});

test("Git paths and baseline inputs outside the supported contract are rejected", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await assert.rejects(changedPaths(binding, "--output=unexpected"), hasCode("INVALID_BASELINE_HEAD"));
  await writeFile(join(fixture.path, "bad\\path.js"), "// unsupported path\n");
  await assert.rejects(changedPaths(binding, fixture.head), hasCode("INVALID_REPOSITORY_PATH"));
});

test("inherited Git variables cannot redirect the bound repository", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const moduleUrl = new URL("../src/git/index.js", import.meta.url).href;
  const script = `import { bindWorktree } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await bindWorktree(process.argv[1])));`;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script, fixture.path], {
    env: { ...process.env, GIT_DIR: join(fixture.root, "wrong.git"), GIT_WORK_TREE: fixture.root },
  });
  const binding = JSON.parse(result.stdout) as WorktreeBinding;
  assert.equal(binding.root, fixture.path);
  assert.equal(binding.head, fixture.head);
});

test("unresolved merge conflicts reject path collection even when the original baseline remains valid", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const task = taskFor(binding);
  await git(fixture.path, ["checkout", "-b", "conflicting-change"]);
  await writeFile(join(fixture.path, "README.md"), "Feature branch version\n");
  await git(fixture.path, ["add", "--", "README.md"]);
  await git(fixture.path, ["commit", "-m", "Feature README change"]);
  await git(fixture.path, ["checkout", "main"]);
  await writeFile(join(fixture.path, "README.md"), "Main branch version\n");
  await git(fixture.path, ["add", "--", "README.md"]);
  await git(fixture.path, ["commit", "-m", "Main README change"]);
  await assert.rejects(git(fixture.path, ["merge", "--no-commit", "conflicting-change"]));
  await assertBaseline(binding, task);
  await assert.rejects(changedPaths(binding, fixture.head), hasCode("UNMERGED_CHANGES"));
});
