import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { TaskSchema, type ChangeItem } from "../src/domain/task.js";
import { TaskService } from "../src/task-service.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const request = { requirement: "Add disabled account behavior", acceptance_criteria: [{ id: "disabled", description: "Disabled accounts cannot access the application" }] };
function item(id: string, path: string): ChangeItem {
  return { id, target_path: path, action: "modify", requirement: `Review ${id}`, rationale: "Related account entry point",
    sources: [{ kind: "code", reference: path }], status: "pending", evidence: [] };
}

test("writer-only changes remain incomplete and evidence cannot be replaced by file coverage", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  const checklist = [item("writer", "src/service.js"), item("login-and-session", "src/auth.js"), item("view", "src/view.js")];
  const updated = TaskSchema.parse((await service.update({ task_id: task.id, expected_revision: 0, change_items: checklist })).data);
  assert.equal(updated.revision, 1);
  const path = join(fixture.path, "src/service.js");
  await writeFile(path, (await readFile(path, "utf8")).replace('new Set(["active"])', 'new Set(["active", "disabled"])'));
  const checked = await service.check({ task_id: task.id });
  assert.equal(checked.outcome, "incomplete");
  const data = checked.data as { pending_items: string[]; changed_paths: string[]; structurally_reviewed: boolean };
  assert.deepEqual(data.pending_items, ["writer", "login-and-session", "view"]);
  assert.deepEqual(data.changed_paths, ["src/service.js"]);
  assert.equal(data.structurally_reviewed, false);
  const invalid = await service.update({ task_id: task.id, expected_revision: 1,
    change_items: checklist.map((entry) => ({ ...entry, status: "checked", reviewed_by: "developer" })) });
  assert.equal(invalid.outcome, "error");
  const latest = (await service.check({ task_id: task.id })).data as { recorded_task: unknown };
  assert.equal(TaskSchema.parse(latest.recorded_task).revision, 1);
});

test("updates preserve existing checklist records and reject stale revisions", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  await service.update({ task_id: task.id, expected_revision: 0, change_items: [item("writer", "src/service.js")] });
  assert.equal((await service.update({ task_id: task.id, expected_revision: 0 })).code, "REVISION_CONFLICT");
  assert.equal((await service.update({ task_id: task.id, expected_revision: 1, change_items: [] })).code, "RECORD_REMOVAL_NOT_ALLOWED");
  assert.equal(TaskSchema.parse(((await service.check({ task_id: task.id })).data as { recorded_task: unknown }).recorded_task).revision, 1);
});

test("baseline changes do not become successful checks, and interrupted tasks can be explicitly aborted", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  execFileSync("git", ["switch", "-c", "other"], { cwd: fixture.path, stdio: "pipe" });
  const check = await service.check({ task_id: task.id });
  assert.equal(check.outcome, "incomplete");
  assert.equal(check.code, "BASELINE_BRANCH_CHANGED");
  const stopped = await service.update({ task_id: task.id, expected_revision: 0, phase: "aborted", abort_reason: "User switched branches" });
  assert.equal(stopped.outcome, "ok");
  assert.equal((await service.check({ task_id: task.id })).code, "TASK_INACTIVE");
  assert.equal((await service.open(request)).outcome, "ok");
});

test("closing refuses changed paths that have not been included in the reviewed checklist", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  await writeFile(join(fixture.path, "unexpected.js"), "export const value = 1;\n");
  const evidence = [{ kind: "manual", reference: "review-session", summary: "Reviewed entry point" }];
  const closed = await service.update({ task_id: task.id, expected_revision: 0, phase: "closed",
    change_items: [{ ...item("writer", "src/service.js"), status: "checked", reviewed_by: "developer", evidence }],
    acceptance_criteria: [{ id: "disabled", description: request.acceptance_criteria[0]?.description, status: "checked", reviewed_by: "developer", evidence }] });
  assert.equal(closed.code, "UNREVIEWED_CHANGES");
});

test("a verified change can close, survives restart, and releases the task after a normal commit", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const service = new TaskService(binding);
  const task = TaskSchema.parse((await service.open({ requirement: "Document the existing service boundary", acceptance_criteria: [{ id: "policy", description: "README points readers to the existing project policy" }] })).data);
  const path = join(fixture.path, "README.md");
  await writeFile(path, `${await readFile(path, "utf8")}\nImplementation policy: see AGENTS.md and docs/account-policy.md.\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const output = execFileSync(process.execPath, ["--test"], { cwd: fixture.path, encoding: "utf8", env });
  assert.match(output, /# fail 0/);
  const evidence = [{ kind: "manual", reference: "README.md", summary: "The added reference names the existing convention and business-policy documents." }];
  const reviewed = await service.update({ task_id: task.id, expected_revision: 0,
    change_items: [{ ...item("readme", "README.md"), status: "checked", reviewed_by: "fixture", evidence }],
    acceptance_criteria: [{ id: "policy", description: "README points readers to the existing project policy", status: "checked", reviewed_by: "fixture", evidence }],
    validations: [{ id: "baseline-tests", description: "node --test", outcome: "passed", evidence: [{ kind: "test", reference: "node --test", summary: "Existing sample tests passed with zero failures" }] }] });
  assert.equal(reviewed.outcome, "ok");
  assert.equal((await service.check({ task_id: task.id })).code, "CHECKLIST_REVIEWED");
  const closed = await service.update({ task_id: task.id, expected_revision: 1, phase: "closed" });
  assert.equal(closed.outcome, "ok");
  const restarted = new TaskService(await bindWorktree(fixture.path));
  assert.equal((await restarted.check({ task_id: task.id })).code, "TASK_INACTIVE");
  execFileSync("git", ["add", "README.md"], { cwd: fixture.path });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Clarify fixture policy"], { cwd: fixture.path, stdio: "pipe" });
  assert.equal((await restarted.open(request)).outcome, "ok");
});

test("an unresolved merge stays incomplete at the service boundary and cannot be closed", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: fixture.path, stdio: "pipe" });
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  git(["checkout", "-b", "conflicting"]);
  await writeFile(join(fixture.path, "README.md"), "Conflicting side\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Side"]);
  git(["checkout", "main"]);
  await writeFile(join(fixture.path, "README.md"), "Main side\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Main"]);
  assert.throws(() => git(["merge", "--no-commit", "conflicting"]));
  const checked = await service.check({ task_id: task.id });
  assert.equal(checked.outcome, "incomplete");
  assert.equal(checked.code, "UNMERGED_CHANGES");
  assert.equal((await service.update({ task_id: task.id, expected_revision: 0, phase: "closed" })).code, "UNMERGED_CHANGES");
});
