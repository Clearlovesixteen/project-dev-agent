import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { TaskSchema, type Task } from "../src/domain/task.js";
import { TaskStore } from "../src/storage/task-store.js";
import { createGitFixture, type GitFixture } from "./helpers/create-git-fixture.js";

const execFileAsync = promisify(execFile);
const evidence = { kind: "manual", reference: "review/account suspension", summary: "Reviewed lifecycle consumers" };

function freshTask(fixture: GitFixture, id = "task-1"): Task {
  const now = new Date().toISOString();
  return TaskSchema.parse({
    schema_version: 1, id, revision: 0, repo_identity: join(fixture.path, ".git"),
    worktree_path: fixture.path, baseline_head: fixture.head, baseline_branch: "main", phase: "active",
    requirement: "Add account suspension", acceptance_criteria: [{ id: "login", description: "Suspended login is rejected" }],
    change_items: [{
      id: "auth", target_path: "src/auth.js", action: "modify", requirement: "Check account state",
      rationale: "Login consumes account lifecycle state", sources: [{ kind: "code", reference: "src/auth.js" }],
    }], created_at: now, updated_at: now,
  });
}

function closedTask(current: Task): Task {
  return TaskSchema.parse({
    ...current, phase: "closed",
    acceptance_criteria: current.acceptance_criteria.map((item) => ({ ...item, status: "checked", reviewed_by: "developer", evidence: [evidence] })),
    change_items: current.change_items.map((item) => ({ ...item, status: "checked", reviewed_by: "developer", evidence: [evidence] })),
    validations: [{ id: "review", description: "Review all affected entry points", outcome: "passed", evidence: [evidence] }],
  });
}

test("task records survive reinstantiation and load returns an independent value", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const task = freshTask(fixture);
  const created = await new TaskStore(fixture.path).create(task);
  assert.deepEqual(created, task);
  created.requirement = "Changed caller object";
  const loaded = await new TaskStore(fixture.path).load(task.id);
  assert.equal(loaded.requirement, task.requirement);
  assert.equal(loaded.baseline_head, fixture.head);
});

test("duplicate IDs and overlapping active tasks are rejected", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await store.create(freshTask(fixture));
  await assert.rejects(store.create(freshTask(fixture)), { code: "TASK_EXISTS" });
  await assert.rejects(new TaskStore(fixture.path).create(freshTask(fixture, "task-2")), { code: "ACTIVE_TASK_EXISTS" });
});

test("concurrent updates cannot both commit the same revision", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const first = new TaskStore(fixture.path);
  await first.create(freshTask(fixture));
  const updates = await Promise.allSettled([
    first.update("task-1", 0, (current) => ({ ...current, requirement: "First edit" })),
    new TaskStore(fixture.path).update("task-1", 0, (current) => ({ ...current, requirement: "Second edit" })),
  ]);
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  const failure = updates.find((result) => result.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.ok(["STORE_BUSY", "REVISION_CONFLICT"].includes((failure.reason as { code: string }).code));
  assert.equal((await first.load("task-1")).revision, 1);
  await assert.rejects(first.update("task-1", 0, (current) => current), { code: "REVISION_CONFLICT" });
});

test("closing retains a read-only record and releases the active-task constraint", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await store.create(freshTask(fixture));
  const closed = await store.update("task-1", 0, closedTask);
  assert.equal(closed.phase, "closed");
  assert.equal(closed.revision, 1);
  await assert.rejects(store.update("task-1", 1, (current) => current), { code: "TASK_READ_ONLY" });
  await store.create(freshTask(fixture, "task-2"));
  assert.equal((await new TaskStore(fixture.path).load("task-1")).phase, "closed");
});

test("aborting preserves pending work and permits a new task", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await store.create(freshTask(fixture));
  const aborted = await store.update("task-1", 0, (current) => ({ ...current, phase: "aborted", abort_reason: "Requirement withdrawn" }));
  assert.equal(aborted.change_items[0]?.status, "pending");
  await assert.rejects(store.update("task-1", 1, (current) => current), { code: "TASK_READ_ONLY" });
  await store.create(freshTask(fixture, "task-2"));
});

test("invalid or immutable-field updates do not damage the prior record", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  const before = await store.create(freshTask(fixture));
  const path = join(fixture.path, ".project-dev", "local", "tasks", "task-1.json");
  const bytes = await readFile(path, "utf8");
  await assert.rejects(store.update("task-1", 0, (current) => ({ ...current, phase: "closed" })), { code: "INVALID_TASK" });
  await assert.rejects(store.update("task-1", 0, (current) => ({ ...current, baseline_head: "b".repeat(40) })), { code: "IMMUTABLE_TASK_FIELD" });
  await assert.rejects(store.update("task-1", 0, (current) => { current.id = "task-2"; return current; }), { code: "IMMUTABLE_TASK_FIELD" });
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await store.load("task-1"), before);
});

test("the store rejects unsafe task identifiers and mismatched worktree bindings", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await assert.rejects(store.load("../outside"), { code: "INVALID_TASK_ID" });
  await assert.rejects(store.update("../outside", 0, (current) => current), { code: "INVALID_TASK_ID" });
  await assert.rejects(store.create({ ...freshTask(fixture), worktree_path: fixture.root }), { code: "STATE_PATH_UNSAFE" });
});

test("symlinks at each state-directory level cannot redirect storage", async (t) => {
  for (const segment of [".project-dev", "local", "tasks"]) {
    const fixture = await createGitFixture();
    t.after(fixture.cleanup);
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    const parent = segment === ".project-dev" ? fixture.path
      : segment === "local" ? join(fixture.path, ".project-dev")
      : join(fixture.path, ".project-dev", "local");
    await mkdir(parent, { recursive: true });
    await symlink(outside, join(parent, segment));
    await assert.rejects(new TaskStore(fixture.path).create(freshTask(fixture)), { code: "STATE_PATH_UNSAFE" });
    await assert.rejects(readFile(join(outside, "task-1.json")), { code: "ENOENT" });
  }
});

test("symlinked task records and lock records are rejected", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await store.create(freshTask(fixture));
  const outside = join(fixture.root, "outside.json");
  await writeFile(outside, JSON.stringify(freshTask(fixture, "task-link")));
  await symlink(outside, join(fixture.path, ".project-dev", "local", "tasks", "task-link.json"));
  await assert.rejects(store.load("task-link"), { code: "STATE_PATH_UNSAFE" });
  await symlink(outside, join(fixture.path, ".project-dev", "local", ".task-store.lock"));
  await assert.rejects(store.update("task-1", 0, (current) => current), { code: "STATE_PATH_UNSAFE" });
});

test("a live owner makes mutations busy while reads remain available", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await store.create(freshTask(fixture));
  await writeFile(join(fixture.path, ".project-dev", "local", ".task-store.lock"), JSON.stringify({ pid: process.pid, token: randomUUID() }));
  await assert.rejects(store.update("task-1", 0, (current) => current), { code: "STORE_BUSY" });
  assert.equal((await new TaskStore(fixture.path).load("task-1")).revision, 0);
});

test("a new store recovers a dead process lock, including an abandoned recovery lock", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  await new TaskStore(fixture.path).create(freshTask(fixture));
  const exited = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const owner = JSON.stringify({ pid: Number(exited.stdout), token: randomUUID() });
  const lock = join(fixture.path, ".project-dev", "local", ".task-store.lock");
  await writeFile(lock, owner);
  await writeFile(`${lock}.recover`, owner);
  const updated = await new TaskStore(fixture.path).update("task-1", 0, (current) => ({ ...current, requirement: "Recovered task" }));
  assert.equal(updated.revision, 1);
  assert.equal((await new TaskStore(fixture.path).load("task-1")).requirement, "Recovered task");
});

test("oversized, malformed and nonregular records fail without being consumed as tasks", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const store = new TaskStore(fixture.path);
  await store.create(freshTask(fixture));
  const tasks = join(fixture.path, ".project-dev", "local", "tasks");
  await writeFile(join(tasks, "large.json"), "x".repeat(1_000_001));
  await assert.rejects(store.load("large"), { code: "STATE_LIMIT" });
  await writeFile(join(tasks, "broken.json"), "{");
  await assert.rejects(store.load("broken"), { code: "STATE_CORRUPT" });
  await mkdir(join(tasks, "directory.json"));
  await assert.rejects(store.load("directory"), { code: "STATE_PATH_UNSAFE" });
});
