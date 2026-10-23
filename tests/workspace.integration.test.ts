import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { TaskSchema } from "../src/domain/task.js";
import { bindWorktree } from "../src/git/index.js";
import { prepareProject } from "../src/personal-setup.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { createSample } from "../src/sample/create.js";
import { TaskService } from "../src/task-service.js";
import { Workspace } from "../src/workspace.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const request = { requirement: "Review existing account behavior", acceptance_criteria: [{ id: "review", description: "Review the existing sources" }] };
function git(path: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: path, encoding: "utf8" });
}
async function withoutStateIgnore(path: string) {
  await writeFile(join(path, ".gitignore"), "node_modules/\n");
  git(path, ["add", ".gitignore"]);
  git(path, ["commit", "-m", "Remove fixture-specific state ignore"]);
}

test("personal preparation preserves shared files and unrelated Git excludes, is previewable and repeatable", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  await withoutStateIgnore(fixture.path);
  const binding = await bindWorktree(fixture.path);
  const exclude = join(binding.repo_identity, "info/exclude");
  await mkdir(join(binding.repo_identity, "info"), { recursive: true });
  await writeFile(exclude, "# personal patterns\n*.scratch");
  const before = git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const preview = await prepareProject(binding, {});
  assert.equal((preview.data as { state_ignored: boolean }).state_ignored, false);
  assert.equal(await readFile(exclude, "utf8"), "# personal patterns\n*.scratch");
  await assert.rejects(access(join(fixture.path, ".project-dev")), { code: "ENOENT" });
  const applied = await prepareProject(binding, { apply: true });
  assert.equal((applied.data as { ready_to_open: boolean }).ready_to_open, true);
  const first = await readFile(exclude, "utf8");
  assert.ok(first.startsWith("# personal patterns\n*.scratch\n"));
  await prepareProject(binding, { apply: true });
  assert.equal(await readFile(exclude, "utf8"), first);
  assert.equal(git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]), before);
  const service = new TaskService(binding);
  const task = TaskSchema.parse((await service.open(request)).data);
  assert.equal(git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  const restarted = new TaskService(await bindWorktree(fixture.path));
  const recovered = await restarted.check({});
  assert.equal(TaskSchema.parse((recovered.data as { recorded_task: unknown }).recorded_task).id, task.id);
  git(fixture.path, ["switch", "-c", "changed-branch"]);
  const changed = await restarted.check({});
  assert.equal(changed.code, "BASELINE_BRANCH_CHANGED");
  assert.equal(TaskSchema.parse((changed.data as { recorded_task: unknown }).recorded_task).id, task.id);
  assert.equal((await restarted.update({ task_id: task.id, expected_revision: 0, phase: "aborted", abort_reason: "Connection verification ended" })).outcome, "ok");
  assert.equal((await restarted.check({})).code, "NO_ACTIVE_TASK");
});

test("preparation preserves existing work and rejects unsafe or busy Git metadata", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  await withoutStateIgnore(fixture.path);
  const binding = await bindWorktree(fixture.path);
  await writeFile(join(fixture.path, "existing-work.txt"), "developer's unfinished work\n");
  const status = git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const lock = join(binding.repo_identity, "info/exclude.lock");
  await mkdir(join(binding.repo_identity, "info"), { recursive: true });
  await writeFile(lock, "another process\n");
  await assert.rejects(prepareProject(binding, { apply: true }), { code: "GIT_EXCLUDE_BUSY" });
  assert.equal(await readFile(lock, "utf8"), "another process\n");
  const { unlink } = await import("node:fs/promises");
  await unlink(lock);
  const data = (await prepareProject(binding, { apply: true })).data as { worktree_clean: boolean; ready_to_open: boolean };
  assert.equal(data.worktree_clean, false);
  assert.equal(data.ready_to_open, false);
  assert.equal((await new TaskService(binding).open(request)).code, "WORKTREE_DIRTY");
  assert.equal(git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]), status);
  assert.equal(await readFile(join(fixture.path, "existing-work.txt"), "utf8"), "developer's unfinished work\n");
  const other = await createGitFixture();
  t.after(other.cleanup);
  await withoutStateIgnore(other.path);
  const otherBinding = await bindWorktree(other.path);
  await mkdir(join(otherBinding.repo_identity, "info"), { recursive: true });
  await symlink(join(fixture.path, "existing-work.txt"), join(otherBinding.repo_identity, "info/exclude"));
  await assert.rejects(prepareProject(otherBinding, { apply: true }), { code: "PATH_UNSAFE" });
});

test("first use needs no project bootstrap, but missing explicitly configured knowledge remains visible", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  await withoutStateIgnore(fixture.path);
  const binding = await bindWorktree(fixture.path);
  await assert.rejects(access(join(binding.repo_identity, "info")), { code: "ENOENT" });
  await prepareProject(binding, { apply: true });
  assert.equal(git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  const knowledge = new KnowledgeService(binding);
  const first = await knowledge.search({ query: "account" });
  assert.equal(first.outcome, "ok");
  assert.deepEqual((first.data as { results: unknown[] }).results, []);
  await new ProjectFiles(binding.root).create(".project-dev/project.yaml", "schema_version: 1\nknowledge_dir: docs/team-knowledge\n");
  const configured = await knowledge.search({ query: "account" });
  assert.equal(configured.outcome, "incomplete");
  assert.ok(configured.diagnostics.some((entry) => entry.code === "KNOWLEDGE_DIRECTORY_MISSING"));
});

test("one STDIO connection routes independent projects and recovers tasks after restart without cross-project state", { timeout: 30_000 }, async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const second = await createSample(join(fixture.root, "second project"));
  const outside = await createGitFixture();
  t.after(outside.cleanup);
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  async function connect() {
    const client = new Client({ name: "workspace-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--workspace", fixture.root], stderr: "pipe" }));
    return client;
  }
  const client = await connect();
  const call = async (name: string, arguments_: Record<string, unknown>) => ToolResultSchema.parse((await client.callTool({ name, arguments: arguments_ })).structuredContent);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 13);
  assert.ok(tools.every((tool) => tool.inputSchema.required?.includes("project")));
  assert.equal((await call("task_check", { project: outside.path })).code, "PROJECT_OUTSIDE_WORKSPACE");
  await symlink(outside.path, join(fixture.root, "linked-project"));
  assert.equal((await call("task_check", { project: join(fixture.root, "linked-project") })).code, "PROJECT_PATH_UNSAFE");
  assert.equal((await call("project_prepare", { project: fixture.root })).code, "NOT_GIT_WORKTREE");
  assert.equal((await call("project_prepare", { project: fixture.path })).outcome, "ok");
  const a = TaskSchema.parse((await call("task_open", { project: fixture.path, ...request })).data);
  const b = TaskSchema.parse((await call("task_open", { project: second.path, ...request })).data);
  assert.notEqual(a.id, b.id);
  assert.equal((await call("task_update", { project: second.path, task_id: a.id, expected_revision: 0, phase: "aborted", abort_reason: "Wrong project" })).code, "TASK_NOT_FOUND");
  assert.equal((await call("knowledge_search", { project: fixture.path, query: "account" })).outcome, "ok");
  await client.close();
  const restarted = await connect();
  const recovered = ToolResultSchema.parse((await restarted.callTool({ name: "task_check", arguments: { project: fixture.path } })).structuredContent);
  assert.equal(TaskSchema.parse((recovered.data as { recorded_task: unknown }).recorded_task).id, a.id);
  const secondState = ToolResultSchema.parse((await restarted.callTool({ name: "task_check", arguments: { project: second.path } })).structuredContent);
  assert.equal(TaskSchema.parse((secondState.data as { recorded_task: unknown }).recorded_task).id, b.id);
});

test("workspace requires explicit roots and rejects linked Git metadata outside its boundary", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const outside = await createGitFixture();
  t.after(outside.cleanup);
  const workspace = await Workspace.open(fixture.root);
  await assert.rejects(workspace.bind(), { code: "PROJECT_REQUIRED" });
  await assert.rejects(workspace.bind("relative"), { code: "PROJECT_REQUIRED" });
  await assert.rejects(workspace.bind(join(fixture.path, "src")), { code: "WORKTREE_ROOT_REQUIRED" });
  const linkedWorktree = join(fixture.root, "outside-git-common");
  git(outside.path, ["worktree", "add", "--detach", linkedWorktree]);
  await assert.rejects(workspace.bind(linkedWorktree), { code: "PROJECT_OUTSIDE_WORKSPACE" });
});
