import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceCriterionSchema, ChangeItemSchema, TaskSchema } from "../src/domain/task.js";
import { ToolResultSchema } from "../src/domain/result.js";

const source = { kind: "code", reference: "src/auth.js:1" };
const evidence = { kind: "test", reference: "node --test", summary: "Disabled accounts cannot authenticate" };
const item = {
  id: "auth", target_path: "src/auth.js", action: "modify", requirement: "Reject disabled accounts",
  rationale: "Changing the writer alone does not protect login", sources: [source], status: "pending",
};
const activeTask = {
  schema_version: 1, id: "task-1", revision: 0, repo_identity: "/tmp/example/.git",
  worktree_path: "/tmp/example", baseline_head: "a".repeat(40), baseline_branch: "main", phase: "active",
  requirement: "Add account suspension", acceptance_criteria: [{ id: "login", description: "Suspended accounts cannot log in" }],
  change_items: [item], created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z",
};

test("an active task preserves pending work without inventing review evidence", () => {
  const task = TaskSchema.parse(activeTask);
  assert.equal(task.change_items[0]?.status, "pending");
  assert.deepEqual(task.change_items[0]?.evidence, []);
  assert.equal(task.acceptance_criteria[0]?.status, "pending");
});

test("marking a changed path as checked is rejected without a reviewer and evidence", () => {
  assert.equal(ChangeItemSchema.safeParse({ ...item, status: "checked" }).success, false);
  assert.equal(ChangeItemSchema.safeParse({ ...item, status: "checked", reviewed_by: "developer" }).success, false);
  assert.equal(ChangeItemSchema.safeParse({ ...item, status: "checked", reviewed_by: "developer", evidence: [evidence] }).success, true);
});

test("skipping a related location requires an attributable reason", () => {
  assert.equal(ChangeItemSchema.safeParse({ ...item, status: "skipped", reviewed_by: "developer" }).success, false);
  assert.equal(ChangeItemSchema.safeParse({ ...item, status: "skipped", reviewed_by: "developer", skip_reason: "This entry point delegates to the reviewed guard" }).success, true);
});

test("acceptance is independently reviewed, not inferred from a completed checklist", () => {
  assert.equal(AcceptanceCriterionSchema.safeParse({ id: "login", description: "Login is protected", status: "checked" }).success, false);
  const task = { ...activeTask, phase: "closed", change_items: [{ ...item, status: "checked", reviewed_by: "developer", evidence: [evidence] }] };
  assert.equal(TaskSchema.safeParse(task).success, false);
});

test("closing requires reviewed acceptance, no pending items and no failed or unexecuted validation", () => {
  const closed = {
    ...activeTask, phase: "closed",
    acceptance_criteria: [{ id: "login", description: "Disabled login is rejected", status: "checked", reviewed_by: "developer", evidence: [evidence] }],
    change_items: [{ ...item, status: "checked", reviewed_by: "developer", evidence: [evidence] }],
    validations: [{ id: "auth-tests", description: "Run auth tests", outcome: "passed", evidence: [evidence] }],
  };
  assert.equal(TaskSchema.safeParse(closed).success, true);
  assert.equal(TaskSchema.safeParse({ ...closed, change_items: [item] }).success, false);
  assert.equal(TaskSchema.safeParse({ ...closed, change_items: [] }).success, false);
  assert.equal(TaskSchema.safeParse({ ...closed, validations: [{ ...closed.validations[0], outcome: "failed" }] }).success, false);
  assert.equal(TaskSchema.safeParse({ ...closed, validations: [{ id: "later", description: "Run validation", outcome: "not_run" }] }).success, false);
});

test("aborted tasks retain pending work and explain why the task stopped", () => {
  assert.equal(TaskSchema.safeParse({ ...activeTask, phase: "aborted" }).success, false);
  const task = TaskSchema.parse({ ...activeTask, phase: "aborted", abort_reason: "Requirement changed" });
  assert.equal(task.change_items[0]?.status, "pending");
});

test("unknown fields, duplicate IDs and invalid revision or chronology cannot silently enter a record", () => {
  assert.equal(TaskSchema.safeParse({ ...activeTask, changed_files: [] }).success, false);
  assert.equal(TaskSchema.safeParse({ ...activeTask, change_items: [item, item] }).success, false);
  assert.equal(TaskSchema.safeParse({ ...activeTask, revision: -1 }).success, false);
  assert.equal(TaskSchema.safeParse({ ...activeTask, updated_at: "2026-10-12T00:00:00Z" }).success, false);
});

test("task IDs and target paths cannot contain traversal segments", () => {
  assert.equal(TaskSchema.safeParse({ ...activeTask, id: "../outside" }).success, false);
  assert.equal(ChangeItemSchema.safeParse({ ...item, target_path: "../auth.js" }).success, false);
  assert.equal(ChangeItemSchema.safeParse({ ...item, target_path: "/tmp/auth.js" }).success, false);
});

test("failure and incomplete outcomes carry explanations instead of success-shaped silence", () => {
  assert.equal(ToolResultSchema.safeParse({ outcome: "error", code: "WRITE_FAILED" }).success, false);
  assert.equal(ToolResultSchema.safeParse({ outcome: "incomplete", code: "NOT_REVIEWED" }).success, false);
  assert.equal(ToolResultSchema.safeParse({ outcome: "incomplete", code: "NOT_REVIEWED", diagnostics: [{ code: "PENDING", message: "Login entry point remains unreviewed" }] }).success, true);
});
