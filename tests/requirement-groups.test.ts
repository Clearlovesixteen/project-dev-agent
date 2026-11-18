import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { TaskSchema } from "../src/domain/task.js";
import { TaskService } from "../src/task-service.js";
import { RequirementGroupStore } from "../src/coordination/requirement-groups.js";
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
