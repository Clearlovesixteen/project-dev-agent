import { runFixtureChecks, withImplementationBasis } from "./helpers/implementation-basis.js";
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
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
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
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
  await service.update({ task_id: task.id, expected_revision: 0, change_items: [item("writer", "src/service.js")] });
  assert.equal((await service.update({ task_id: task.id, expected_revision: 0 })).code, "REVISION_CONFLICT");
  assert.equal((await service.update({ task_id: task.id, expected_revision: 1, change_items: [] })).code, "RECORD_REMOVAL_NOT_ALLOWED");
  assert.equal(TaskSchema.parse(((await service.check({ task_id: task.id })).data as { recorded_task: unknown }).recorded_task).revision, 1);
});

test("baseline changes do not become successful checks, and interrupted tasks can be explicitly aborted", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
  execFileSync("git", ["switch", "-c", "other"], { cwd: fixture.path, stdio: "pipe" });
  const check = await service.check({ task_id: task.id });
  assert.equal(check.outcome, "incomplete");
  assert.equal(check.code, "BASELINE_BRANCH_CHANGED");
  const stopped = await service.update({ task_id: task.id, expected_revision: 0, phase: "aborted", abort_reason: "User switched branches" });
  assert.equal(stopped.outcome, "ok");
  assert.equal((await service.check({ task_id: task.id })).code, "TASK_INACTIVE");
  assert.equal((await service.open(await withImplementationBasis(fixture.path, request))).outcome, "ok");
});

test("closing refuses changed paths that have not been included in the reviewed checklist", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
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
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, { requirement: "Document the existing service boundary", acceptance_criteria: [{ id: "policy", description: "README points readers to the existing project policy" }] }))).data);
  const path = join(fixture.path, "README.md");
  await writeFile(path, `${await readFile(path, "utf8")}\nImplementation policy: see AGENTS.md and docs/account-policy.md.\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const snapshot = ((await service.check({ task_id: task.id })).data as any).review_snapshot;
  const output = execFileSync(process.execPath, ["--test"], { cwd: fixture.path, encoding: "utf8", env });
  assert.match(output, /# fail 0/);
  const evidence = [{ kind: "manual", reference: "README.md", summary: "The added reference names the existing convention and business-policy documents." }];
  const reviewed = await service.update({ task_id: task.id, expected_revision: 0, review_snapshot: snapshot,
    change_items: [{ ...item("readme", "README.md"), status: "checked", reviewed_by: "fixture", evidence }],
    acceptance_criteria: [{ id: "policy", description: "README points readers to the existing project policy", status: "checked", reviewed_by: "fixture", evidence }],
    validations: [{ id: "baseline-tests", description: "node --test", outcome: "passed", evidence: [{ kind: "test", reference: "node --test", summary: "Existing sample tests passed with zero failures" }] }] });
  assert.equal(reviewed.outcome, "ok");
  await runFixtureChecks(fixture.path, task.id);
  assert.equal((await service.check({ task_id: task.id })).code, "CHECKLIST_REVIEWED");
  const closed = await service.update({ task_id: task.id, expected_revision: 1, phase: "closed" });
  assert.equal(closed.outcome, "ok");
  const restarted = new TaskService(await bindWorktree(fixture.path));
  assert.equal((await restarted.check({ task_id: task.id })).code, "TASK_INACTIVE");
  execFileSync("git", ["add", "README.md"], { cwd: fixture.path });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Clarify fixture policy"], { cwd: fixture.path, stdio: "pipe" });
  assert.equal((await restarted.open(await withImplementationBasis(fixture.path, request))).outcome, "ok");
});

test("用户修订要求后保留来源和原始需求，并在重新验收前保持未完成", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), service = new TaskService(binding);
  const task = TaskSchema.parse((await service.open({ ...(await withImplementationBasis(fixture.path, { acceptance_criteria: [{ id: "title" }] })), requirement: "将说明标题设为主菜单",
    acceptance_criteria: [{ id: "title", description: "说明标题为主菜单" }] })).data);
  const path = join(fixture.path, "README.md"); await writeFile(path, "# 主菜单\n");
  const snapshot = ((await service.check({ task_id: task.id })).data as any).review_snapshot;
  assert.equal(await readFile(path, "utf8"), "# 主菜单\n");
  const evidence = [{ kind: "manual", reference: "README.md", summary: "已核对标题为主菜单" }];
  const original = TaskSchema.parse((await service.update({ task_id: task.id, expected_revision: 0, review_snapshot: snapshot,
    change_items: [{ ...item("readme", "README.md"), status: "checked", reviewed_by: "fixture", evidence }],
    acceptance_criteria: [{ id: "title", description: "说明标题为主菜单", status: "checked", reviewed_by: "fixture", evidence }],
  })).data);

  // 新要求先改变验收条件并清空旧证据，不能因代码尚未变化就沿用原通过结论。
  const revised = TaskSchema.parse((await service.update({ task_id: task.id, expected_revision: original.revision,
    acceptance_criteria: [{ id: "title", description: "说明标题改为订单管理", status: "pending", evidence: [] }],
    corrections: [{ id: "title-request", description: "标题改为订单管理", rationale: "本次新增要求取代原文案",
      sources: [{ kind: "experience", reference: "fixture:user-message-2", description: "测试场景中的后续用户要求" }] }],
  })).data);
  assert.equal(revised.requirement, task.requirement);
  assert.equal(revised.acceptance_criteria[0]?.review_snapshot, undefined);
  const restarted = new TaskService(binding);
  const check = (await restarted.check({ task_id: task.id })).data as any;
  assert.deepEqual(check.pending_acceptance, ["title"]);
  assert.equal(check.recorded_task.corrections[0].id, "title-request");
  assert.equal((await restarted.update({ task_id: task.id, expected_revision: revised.revision, phase: "closed" })).outcome, "error");

  await writeFile(path, "# 订单管理\n");
  const current = ((await restarted.check({ task_id: task.id })).data as any).review_snapshot;
  assert.equal(await readFile(path, "utf8"), "# 订单管理\n");
  const updatedEvidence = [{ kind: "manual", reference: "README.md", summary: "按修订后的要求核对标题为订单管理" }];
  await runFixtureChecks(fixture.path, task.id);
  const result = await restarted.update({ task_id: task.id, expected_revision: revised.revision, review_snapshot: current,
    reviewed_ids: { change_items: ["readme"] }, phase: "closed",
    change_items: [{ ...original.change_items[0], evidence: updatedEvidence }],
    acceptance_criteria: [{ ...revised.acceptance_criteria[0], status: "checked", reviewed_by: "fixture", evidence: updatedEvidence }],
  });
  assert.equal(result.outcome, "ok");
  assert.equal(TaskSchema.parse(result.data).corrections[0]?.id, "title-request");
});

test("an unresolved merge stays incomplete at the service boundary and cannot be closed", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: fixture.path, stdio: "pipe" });
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
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

test("代码再次修改后旧验证失效，重新验证才能关闭", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
  const path = join(fixture.path, "src/service.js"), original = await readFile(path, "utf8");
  await writeFile(path, original + "\n// 已审查的注释\n");
  const snapshot = ((await service.check({ task_id: task.id })).data as any).review_snapshot;
  const evidence = [{ kind: "test", reference: "node --test", summary: "样例验证通过" }];
  const review = { task_id: task.id, expected_revision: 0, review_snapshot: snapshot,
    change_items: [{ ...item("service", "src/service.js"), status: "checked", reviewed_by: "fixture", evidence }],
    acceptance_criteria: [{ ...request.acceptance_criteria[0], status: "checked", reviewed_by: "fixture", evidence }],
    validations: [{ id: "tests", description: "node --test", outcome: "passed", evidence }] };
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ["--test"], { cwd: fixture.path, env, stdio: "pipe" });
  assert.equal((await service.update(review)).outcome, "ok");
  await writeFile(path, original + "\nexport const broken = ;\n");
  assert.throws(() => execFileSync(process.execPath, ["--test"], { cwd: fixture.path, env, stdio: "pipe" }));
  assert.equal((await service.check({ task_id: task.id })).code, "REVIEW_STALE");
  assert.equal((await service.update({ task_id: task.id, expected_revision: 1, phase: "closed" })).code, "REVIEW_STALE");
  assert.equal((await service.update({ ...review, expected_revision: 1 })).code, "REVIEW_SNAPSHOT_CHANGED");
  await writeFile(path, original + "\n// 修复后重新验证\n");
  const fresh = ((await service.check({ task_id: task.id })).data as any).review_snapshot;
  execFileSync(process.execPath, ["--test"], { cwd: fixture.path, env, stdio: "pipe" });
  assert.equal((await service.update({ ...review, expected_revision: 1, review_snapshot: fresh,
    reviewed_ids: { change_items: ["service"], acceptance_criteria: ["disabled"], validations: ["tests"] } })).outcome, "ok");
  await runFixtureChecks(fixture.path, task.id);
  assert.equal((await service.update({ task_id: task.id, expected_revision: 2, phase: "closed" })).outcome, "ok");
});

test("缺少指纹的旧记录需要复核，回传伪造的单项指纹不能刷新证据", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
  const evidence = [{ kind: "manual", reference: "src/service.js", summary: "核对源码行为" }];
  const reviewed = { ...item("service", "src/service.js"), status: "checked", reviewed_by: "fixture", evidence };
  const snapshot = ((await service.check({})).data as any).review_snapshot;
  assert.equal((await service.update({ task_id: task.id, expected_revision: 0, change_items: [{ ...reviewed, review_snapshot: snapshot }] })).code, "REVIEW_SNAPSHOT_REQUIRED");
  assert.equal((await service.update({ task_id: task.id, expected_revision: 0, review_snapshot: snapshot, change_items: [reviewed] })).outcome, "ok");
  const path = join(fixture.path, ".project-dev/local/tasks", `${task.id}.json`);
  const legacy = JSON.parse(await readFile(path, "utf8")); delete legacy.change_items[0].review_snapshot;
  await writeFile(path, JSON.stringify(legacy));
  assert.equal((await service.check({})).code, "REVIEW_STALE");
  assert.equal((await service.update({ task_id: task.id, expected_revision: 1, change_items: [{ ...reviewed, review_snapshot: snapshot }] })).outcome, "ok");
  const restored = (await service.check({})).data as any;
  assert.deepEqual(restored.stale_evidence.change_items, ["service"]);
  assert.equal(restored.recorded_task.change_items[0].review_snapshot, undefined);
});

test("审查指纹覆盖未跟踪文件的内容，暂存操作不使相同内容失效", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path)); await service.open(await withImplementationBasis(fixture.path, request));
  const path = join(fixture.path, "new.bin");
  await writeFile(path, Buffer.from([0, 255, 1]));
  const first = ((await service.check({})).data as any).review_snapshot;
  await writeFile(path, Buffer.from([0, 254, 1]));
  const second = ((await service.check({})).data as any).review_snapshot;
  assert.notEqual(second, first);
  execFileSync("git", ["add", "new.bin"], { cwd: fixture.path });
  assert.equal(((await service.check({})).data as any).review_snapshot, second);
});

test("局部复核只刷新明确指定的条目，完整回传不能刷新其他旧证据", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  let task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
  const path = join(fixture.path, "src/service.js"), original = await readFile(path, "utf8");
  await writeFile(path, original + "\n// 初次实现\n");
  const snapshot = ((await service.check({})).data as any).review_snapshot;
  const evidence = [{ kind: "manual", reference: "src/service.js", summary: "检查当前行为" }];
  const reviewed = await service.update({ task_id: task.id, expected_revision: task.revision, review_snapshot: snapshot,
    change_items: ["a", "b"].map((id) => ({ ...item(id, "src/service.js"), status: "checked", reviewed_by: "fixture", evidence })),
    acceptance_criteria: [{ ...request.acceptance_criteria[0], status: "checked", reviewed_by: "fixture", evidence }],
    validations: ["test-a", "test-b"].map((id) => ({ id, description: id, outcome: "passed", evidence })) });
  assert.equal(reviewed.outcome, "ok", JSON.stringify(reviewed)); task = TaskSchema.parse(reviewed.data);
  await writeFile(path, original + "\n// 后续实现改变\n");
  const fresh = ((await service.check({})).data as any).review_snapshot;
  const replacement = { task_id: task.id, expected_revision: task.revision, review_snapshot: fresh,
    change_items: task.change_items, acceptance_criteria: task.acceptance_criteria, validations: task.validations };
  // 旧客户端只传新指纹和原列表时，所有旧证据仍需复核。
  assert.equal((await service.update(replacement)).outcome, "ok");
  const unchanged = (await service.check({})).data as any;
  assert.deepEqual(unchanged.stale_evidence, { change_items: ["a", "b"], acceptance_criteria: ["disabled"], validations: ["test-a", "test-b"] });
  assert.equal((await service.update({ ...replacement, expected_revision: task.revision + 1,
    validations: task.validations.map((record) => ({ ...record, description: "仅修改说明" })) })).code, "REVIEW_CONFIRMATION_REQUIRED");
  const partial = await service.update({ ...replacement, expected_revision: ++task.revision,
    reviewed_ids: { change_items: ["a"], validations: ["test-a"] } });
  assert.equal(partial.outcome, "ok", JSON.stringify(partial)); task = TaskSchema.parse(partial.data);
  const after = (await service.check({})).data as any;
  assert.deepEqual(after.stale_evidence, { change_items: ["b"], acceptance_criteria: ["disabled"], validations: ["test-b"] });
  assert.equal(task.validations.find((entry) => entry.id === "test-b")?.review_snapshot, snapshot);
  assert.equal((await service.update({ task_id: task.id, expected_revision: task.revision, phase: "closed" })).code, "REVIEW_STALE");
  await runFixtureChecks(fixture.path, task.id);
  const final = await service.update({ ...replacement, expected_revision: task.revision,
    change_items: task.change_items, acceptance_criteria: task.acceptance_criteria, validations: task.validations,
    reviewed_ids: { change_items: ["b"], acceptance_criteria: ["disabled"], validations: ["test-b"] }, phase: "closed" });
  assert.equal(final.outcome, "ok", JSON.stringify(final));
});

test("显式复核需要有效指纹和完整集合，不能指定不存在、重复或待处理条目", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(await withImplementationBasis(fixture.path, request))).data);
  const pending = item("a", "src/service.js");
  const base = { task_id: task.id, expected_revision: 0, review_snapshot: ((await service.check({})).data as any).review_snapshot };
  for (const extra of [
    { reviewed_ids: { change_items: ["missing"] }, change_items: [pending] },
    { reviewed_ids: { change_items: ["a"] }, change_items: [pending] },
    { reviewed_ids: { change_items: ["a", "a"] }, change_items: [pending] },
    { reviewed_ids: { change_items: ["a"] } },
    { reviewed_ids: { change_items: ["a"] }, review_snapshot: undefined,
      change_items: [{ ...pending, status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "src/service.js", summary: "复核" }] }] },
  ]) assert.equal((await service.update({ ...base, ...extra })).outcome, "error");
  assert.equal(((await service.check({})).data as any).recorded_task.revision, 0);
});
