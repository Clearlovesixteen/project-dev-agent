import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { TaskSchema } from "../src/domain/task.js";
import { TaskService } from "../src/task-service.js";
import { RequirementGroupStore } from "../src/coordination/requirement-groups.js";
import { TaskStore } from "../src/storage/task-store.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { interactionStorage } from "../src/workflow/interaction.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const baseInput = {
  requirement: "同一采购申请需求：分别实现界面和接口",
  acceptance_criteria: [{ id: "behavior", description: "界面和接口共同满足采购申请流程" }],
};

/** 测试工作树必须来自同一 common-dir，才能验证中心登记而不是复制本地任务。 */
function addWorktree(fixture: { path: string; root: string }, name: string, branch: string) {
  const path = join(fixture.root, name);
  execFileSync("git", ["worktree", "add", "-b", branch, path, "HEAD"], { cwd: fixture.path, stdio: "pipe" });
  return path;
}

test("同一需求组允许不同工作树的 UI/API 子任务，并保留项目范围关系", async (t) => {
  const fixture = await createGitFixture();
  t.after(async () => { await fixture.cleanup(); });
  const childPath = addWorktree(fixture, "api-tree", "requirement-api");
  t.after(() => { try { execFileSync("git", ["worktree", "remove", "--force", childPath], { cwd: fixture.path, stdio: "ignore" }); } catch {} });
  const first = new TaskService(await bindWorktree(fixture.path));
  const opened = TaskSchema.parse((await first.open({ ...baseInput, requirement_role: "ui", scope_paths: ["src/view.js"] })).data);
  const second = new TaskService(await bindWorktree(childPath));
  const childResult = await second.open({ ...baseInput, requirement_role: "api", scope_paths: ["src/service.js"],
    requirement_group_id: opened.requirement_group_id, parent_task_id: opened.id });
  assert.equal(childResult.code, "TASK_OPENED", JSON.stringify(childResult));
  const child = TaskSchema.parse(childResult.data);
  assert.equal(child.requirement_group_id, opened.requirement_group_id);
  assert.equal(child.parallel_state, "parallel_allowed");
  assert.equal(child.parent_task_id, opened.id);
  const group = await new RequirementGroupStore((await bindWorktree(fixture.path)).repo_identity).group(opened.requirement_group_id!);
  assert.equal(group?.tasks.length, 2);
  assert.deepEqual(group?.tasks.map(task => task.requirement_role).sort(), ["api", "ui"]);
});

test("同一需求组的范围重叠只标记人工审查，不自动合并或覆盖", async (t) => {
  const fixture = await createGitFixture();
  t.after(async () => { await fixture.cleanup(); });
  const apiPath = addWorktree(fixture, "api-tree", "requirement-api-overlap");
  const thirdPath = addWorktree(fixture, "review-tree", "requirement-review-overlap");
  t.after(() => { for (const path of [apiPath, thirdPath]) { try { execFileSync("git", ["worktree", "remove", "--force", path], { cwd: fixture.path, stdio: "ignore" }); } catch {} } });
  const parent = TaskSchema.parse((await new TaskService(await bindWorktree(fixture.path)).open({ ...baseInput, requirement_role: "ui", scope_paths: ["src/view.js"] })).data);
  await new TaskService(await bindWorktree(apiPath)).open({ ...baseInput, requirement_role: "api", scope_paths: ["src/service.js"], requirement_group_id: parent.requirement_group_id, parent_task_id: parent.id });
  const overlap = await new TaskService(await bindWorktree(thirdPath)).open({ ...baseInput, requirement_role: "integration", scope_paths: ["src/view.js"], requirement_group_id: parent.requirement_group_id, parent_task_id: parent.id });
  assert.equal(overlap.code, "TASK_OPENED", JSON.stringify(overlap));
  assert.equal(TaskSchema.parse(overlap.data).parallel_state, "scope_overlap_review");
});

test("需求组登记后的并发状态写回任务且保留 revision", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const task = TaskSchema.parse((await interactionStorage.run({ session_id: "coordination-owner" }, () => new TaskService(binding).open({ ...baseInput, scope_paths: ["src/view.js"] }))).data);
  const stored = await interactionStorage.run({ session_id: "coordination-owner" }, () => new TaskStore(fixture.path).syncCoordination(task.id, "scope_overlap_review", ["related-task"]));
  assert.equal(stored.revision, task.revision);
  assert.deepEqual(stored.owner, task.owner);
  assert.equal(stored.parallel_state, "scope_overlap_review");
  assert.deepEqual(stored.related_task_ids, ["related-task"]);
});

test("需求组 reconcile 会归档已删除工作树任务并同步已关闭任务", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const task = TaskSchema.parse((await new TaskService(binding).open({ ...baseInput, scope_paths: ["src/view.js"] })).data);
  const store = new TaskStore(fixture.path);
  await store.update(task.id, task.revision, current => TaskSchema.parse({ ...current, phase: "aborted", abort_reason: "测试结束" }));
  const groups = new RequirementGroupStore(binding.repo_identity);
  const synced = await groups.reconcile();
  assert.deepEqual(synced.synchronized_task_ids, [task.id]);
  assert.equal((await groups.group(task.requirement_group_id!))?.tasks[0]?.phase, "aborted");
  const missing = TaskSchema.parse((await new TaskService(binding).open({ requirement: "待归档的独立需求", acceptance_criteria: [{ id: "missing", description: "任务用于验证归档" }], scope_paths: ["src/service.js"] })).data);
  await unlink(join(fixture.path, ".project-dev/local/tasks", `${missing.id}.json`));
  const archived = await groups.reconcile();
  assert.deepEqual(archived.archived_task_ids, [missing.id]);
  assert.equal((await groups.group(missing.requirement_group_id!))?.tasks.length, 0);
});

test("不同需求组的重叠范围只提示人工审查", async (t) => {
  const fixture = await createGitFixture();
  t.after(async () => { await fixture.cleanup(); });
  const secondPath = addWorktree(fixture, "independent-overlap", "independent-overlap");
  t.after(() => { try { execFileSync("git", ["worktree", "remove", "--force", secondPath], { cwd: fixture.path, stdio: "ignore" }); } catch {} });
  const first = await new TaskService(await bindWorktree(fixture.path)).open({ requirement: "需求 A", acceptance_criteria: [{ id: "a", description: "A 完成" }], scope_paths: ["src/view.js"] });
  const second = await new TaskService(await bindWorktree(secondPath)).open({ requirement: "需求 B", acceptance_criteria: [{ id: "b", description: "B 完成" }], scope_paths: ["src/view.js"] });
  assert.equal(first.outcome, "ok", JSON.stringify(first));
  assert.equal(second.outcome, "ok", JSON.stringify(second));
  assert.ok(second.diagnostics.some(item => item.code === "REQUIREMENT_CROSS_GROUP_SCOPE_OVERLAP_REVIEW"), JSON.stringify(second));
  assert.notEqual(TaskSchema.parse(first.data).requirement_group_id, TaskSchema.parse(second.data).requirement_group_id);
});

test("已结束需求组不能被显式复用，未声明范围按未知范围提示", async (t) => {
  const fixture = await createGitFixture();
  t.after(async () => { await fixture.cleanup(); });
  const secondPath = addWorktree(fixture, "unknown-scope", "unknown-scope");
  const thirdPath = addWorktree(fixture, "unknown-scope-source", "unknown-scope-source");
  t.after(() => { for (const path of [secondPath, thirdPath]) { try { execFileSync("git", ["worktree", "remove", "--force", path], { cwd: fixture.path, stdio: "ignore" }); } catch {} } });
  const first = TaskSchema.parse((await new TaskService(await bindWorktree(fixture.path)).open({ requirement: "已结束需求", acceptance_criteria: [{ id: "done", description: "需求完成" }], scope_paths: ["src/view.js"] })).data);
  const binding = await bindWorktree(fixture.path);
  const files = new ProjectFiles(binding.repo_identity);
  const key = createHash("sha256").update(binding.repo_identity).digest("hex");
  const path = `project-dev-agent/requirement-groups/${key}/registry.json`;
  const before = await files.read(path);
  const registry = JSON.parse(before) as { groups: Array<{ id: string; status: string }> };
  registry.groups.find(group => group.id === first.requirement_group_id)!.status = "integrated";
  await files.replace(path, JSON.stringify(registry) + "\n", before);
  const rejected = await new TaskService(await bindWorktree(secondPath)).open({ requirement: "续接已结束需求", acceptance_criteria: [{ id: "next", description: "不应复用" }], requirement_group_id: first.requirement_group_id, scope_paths: ["src/service.js"] });
  assert.equal(rejected.code, "REQUIREMENT_GROUP_INACTIVE", JSON.stringify(rejected));
  const independent = TaskSchema.parse((await new TaskService(await bindWorktree(thirdPath)).open({ requirement: "未知范围需求", acceptance_criteria: [{ id: "unknown", description: "需要核对范围" }] })).data);
  assert.ok(independent.requirement_group_id);
  const overlapping = await new TaskService(await bindWorktree(secondPath)).open({ requirement: "明确范围需求", acceptance_criteria: [{ id: "scope", description: "需要核对范围" }], scope_paths: ["src/service.js"] });
  assert.ok(overlapping.diagnostics.some(item => item.code === "REQUIREMENT_CROSS_GROUP_SCOPE_OVERLAP_REVIEW"), JSON.stringify(overlapping));
});

test("没有明确关联时仍保持不同需求的同一工作树互斥", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  await service.open({ requirement: "需求 A", acceptance_criteria: [{ id: "a", description: "A 完成" }] });
  const second = await service.open({ requirement: "需求 B", acceptance_criteria: [{ id: "b", description: "B 完成" }] });
  assert.equal(second.code, "ACTIVE_TASK_EXISTS");
  assert.match(second.diagnostics[0]?.message ?? "", /独立工作树/);
});

test("相同文案在不同工作树并发创建时不会自动误认成同一需求", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const b = addWorktree(fixture, "different-requirement", "independent");
  const opened = await Promise.all([fixture.path, b].map(async root => new TaskService(await bindWorktree(root))
    .open({ ...baseInput, requirement_role: "ui" })));
  assert.ok(opened.every(result => result.code === "TASK_OPENED"), JSON.stringify(opened));
  const groups = opened.map(result => TaskSchema.parse(result.data).requirement_group_id);
  assert.notEqual(groups[0], groups[1]);
});

test("普通任务省略 role 仍按唯一来源指纹自动关联需求组", async t => {
  const fixture = await createGitFixture();
  t.after(async () => { await fixture.cleanup(); });
  const childPath = addWorktree(fixture, "source-match-tree", "source-match");
  t.after(() => { try { execFileSync("git", ["worktree", "remove", "--force", childPath], { cwd: fixture.path, stdio: "ignore" }); } catch {} });
  const first = new TaskService(await bindWorktree(fixture.path));
  const source = { id: "prd", kind: "document" as const, path: "AGENTS.md", quote: "# 账户示例项目" };
  const firstResult = await first.open({ ...baseInput, requirement_sources: [source] });
  assert.equal(firstResult.outcome, "ok", JSON.stringify(firstResult));
  const opened = TaskSchema.parse(firstResult.data);
  const second = new TaskService(await bindWorktree(childPath));
  const linked = await second.open({ ...baseInput, requirement_sources: [source] });
  const task = TaskSchema.parse(linked.data);
  assert.equal(linked.code, "TASK_OPENED", JSON.stringify(linked));
  assert.equal(task.requirement_group_id, opened.requirement_group_id);
  assert.equal(task.requirement_group_relationship, "same_requirement_child");
});

test("需求组登记在锁内重算范围，避免并发工作树漏掉重叠审查", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const opened = TaskSchema.parse((await new TaskService(binding).open({
    ...baseInput,
    requirement_role: "ui",
    scope_paths: ["src/parent.js"],
  })).data);
  const store = new RequirementGroupStore(binding.repo_identity);
  const entries = ["requirement-child-a", "requirement-child-b"].map((task_id, index) => ({
    group_id: opened.requirement_group_id!,
    task_id,
    worktree_path: `/tmp/requirement-tree-${index}`,
    branch: `requirement-child-${index}`,
    requirement_role: "api" as const,
    scope_paths: ["src/shared.js"],
    relationship: "same_requirement_child" as const,
    phase: "active" as const,
  }));

  const results = await Promise.all(entries.map(entry => store.register(entry)));
  const overlapResults = results.filter(result => result.scope_state === "scope_overlap_review");
  assert.equal(overlapResults.length, 1, JSON.stringify(results));
  assert.deepEqual(overlapResults[0]?.related_task_ids, [
    results.find(result => result.scope_state !== "scope_overlap_review")?.group.tasks.at(-1)?.task_id,
  ]);
});
