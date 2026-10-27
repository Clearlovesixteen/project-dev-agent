import { runFixtureChecks } from "./helpers/implementation-basis.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskService } from "../src/task-service.js";
import { TaskSchema } from "../src/domain/task.js";
import { bindWorktree } from "../src/git/index.js";
import { digest } from "../src/knowledge/document.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

async function basis(root: string) {
  const text = await readFile(join(root, "src/auth.js"), "utf8");
  return { references: [{ id: "existing", path: "src/auth.js", sha256: digest(text), line: 1, quote: text.split("\n")[0] }],
    decisions: [{ id: "boundary", constraint: "鉴权判断集中在原有职责边界，业务入口复用它", implementation: "沿用 auth 模块的职责与导出约定，新增业务不重复实现鉴权判断",
      reference_ids: ["existing"], acceptance_id: "conventions" }] };
}
const request = { business_assessment:{state:"unchanged",reason:"本夹具核对模块组织和实现依据，不改变已采用业务模型的规则",model_ids:[],delta_ids:[]}, validation_plan: { checks: [{ id: "project-tests", description: "原项目业务测试", command: "node", args: ["--test"], acceptance_ids: ["conventions"] }] }, requirement: "新增独立业务，遵守已有职责和代码习惯", acceptance_criteria: [{ id: "conventions", description: "核对职责拆分、复用选择和现有导出约定" }] };
const evidence = [{ kind: "manual", reference: "src/new-business.js", summary: "核对既有边界、导出与新业务用法" }];
async function finish(service: TaskService, task: any) {
  await runFixtureChecks(task.worktree_path, task.id);
  const check = (await service.check({})).data as any;
  const review = { status: "checked", reviewed_by: "fixture", evidence };
  return service.update({ task_id: task.id, expected_revision: task.revision, review_snapshot: check.review_snapshot, phase: "closed",
    acceptance_criteria: task.acceptance_criteria.map((item: any) => ({ ...item, ...review })),
    change_items: check.changed_paths.map((path: string, index: number) => ({ id: `change-${index}`, target_path: path, action: "modify", requirement: request.requirement,
      rationale: "按已有边界组织业务", sources: [{ kind: "code", reference: "src/auth.js" }], ...review })) });
}

test("通用约束：没有建立项目实现依据时，表面完整的清单不能关闭新任务", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  await writeFile(join(fixture.path, "src/new-business.js"), "export const entry = () => true;\n");
  assert.equal((await finish(service, task)).code, "IMPLEMENTATION_BASIS_REQUIRED");
});

test("项目实现依据核验真实引用，伪造的代码哈希不能建立任务", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path)), input = await basis(fixture.path);
  input.references[0]!.sha256 = "a".repeat(64);
  assert.equal((await service.open({ ...request, implementation_basis: input })).code, "IMPLEMENTATION_REFERENCE_INVALID");
});

test("非请求库任务同样记录实现选择，并复用现有验收完成闭环", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open({ ...request, implementation_basis: await basis(fixture.path) })).data);
  assert.equal(task.implementation_bases?.[0]?.timing, "before_changes");
  await writeFile(join(fixture.path, "src/new-business.js"), "// 业务入口依赖统一认证边界。\nexport const entry = auth => auth.validateSession;\n");
  const pending = (await service.check({})).data as any;
  assert.equal(pending.quality.implementation.state, "pending");
  assert.equal(pending.recorded_task.implementation_bases[0].basis.decisions[0].constraint, "鉴权判断集中在原有职责边界，业务入口复用它");
  const result = await finish(service, task);
  assert.equal(result.outcome, "ok", JSON.stringify(result));
  assert.equal((TaskSchema.parse(result.data).implementation_bases?.length), 1);
});

test("晚补依据如实记录已有改动，补录与关闭分开，历史不会伪装成编码前准备", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data);
  await writeFile(join(fixture.path, "src/new-business.js"), "export const entry = auth => auth.validateSession;\n");
  const input = await basis(fixture.path);
  assert.equal((await service.update({ task_id: task.id, expected_revision: 0, implementation_basis: input, phase: "closed",
    change_items: [{ id: "new", target_path: "src/new-business.js", action: "modify", requirement: request.requirement,
      rationale: "保留业务入口边界", sources: [{ kind: "code", reference: "src/auth.js" }] }] })).code, "IMPLEMENTATION_BASIS_REVIEW_REQUIRED");
  const updated = TaskSchema.parse((await service.update({ task_id: task.id, expected_revision: 0, implementation_basis: input })).data);
  assert.equal(updated.implementation_bases?.[0]?.timing, "after_changes");
  const reopened = new TaskService(await bindWorktree(fixture.path));
  const check = (await reopened.check({})).data as any;
  assert.equal(check.quality.implementation.first_timing, "after_changes");
  assert.equal((await finish(reopened, updated)).outcome, "ok");
});

test("改变实现决策必须重开相关验收，追加历史后再核验，不能套用旧结论", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), service = new TaskService(binding), input = await basis(fixture.path);
  let task = TaskSchema.parse((await service.open({ ...request, implementation_basis: input })).data);
  const snapshot = ((await service.check({})).data as any).review_snapshot;
  task = TaskSchema.parse((await service.update({ task_id: task.id, expected_revision: 0, review_snapshot: snapshot,
    acceptance_criteria: task.acceptance_criteria.map(item => ({ ...item, status: "checked", reviewed_by: "fixture", evidence })) })).data);
  const revised = { ...input, decisions: input.decisions.map(item => ({ ...item, implementation: "保留原认证职责，新业务通过注入接口调用；不为简单逻辑新增策略层" })) };
  const change = { task_id: task.id, expected_revision: task.revision, implementation_basis: revised };
  assert.equal((await service.update(change)).code, "IMPLEMENTATION_BASIS_REVIEW_REQUIRED");
  task = TaskSchema.parse((await service.update({ ...change,
    acceptance_criteria: task.acceptance_criteria.map(({ reviewed_by: _by, review_snapshot: _snapshot, ...item }) => ({ ...item, status: "pending", evidence: [] })) })).data);
  assert.equal(task.implementation_bases?.length, 2);
  assert.deepEqual(task.implementation_bases?.[0]?.basis, input);
  assert.equal(((await service.check({})).data as any).quality.implementation.state, "pending");
  const { TaskStore } = await import("../src/storage/task-store.js");
  await assert.rejects(new TaskStore(binding.root).update(task.id, task.revision, current => ({ ...current, implementation_bases: current.implementation_bases!.slice(1) })), /不能覆盖或移除/);
});

test("原参考文件本身需要修改时保留基线依据，当前实现仍需重新验收", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open({ ...request, implementation_basis: await basis(fixture.path) })).data);
  await writeFile(join(fixture.path, "src/auth.js"), (await readFile(join(fixture.path, "src/auth.js"), "utf8")) + "\n// 保留现有职责边界。\n");
  const check = (await service.check({})).data as any;
  assert.equal(check.quality.implementation.references[0].state, "task_baseline");
  assert.equal(check.quality.implementation.state, "pending");
  assert.equal((await finish(service, task)).outcome, "ok");
});

test("不存在的验收关联与错误行文被拒绝，不把扫描路径当作阅读证明", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path)), input = await basis(fixture.path);
  const unknown = { ...input, decisions: input.decisions.map(item => ({ ...item, acceptance_id: "unknown" })) };
  assert.equal((await service.open({ ...request, implementation_basis: unknown })).code, "IMPLEMENTATION_ACCEPTANCE_UNKNOWN");
  input.references[0]!.quote = "不存在的项目规范";
  assert.equal((await service.open({ ...request, implementation_basis: input })).code, "IMPLEMENTATION_REFERENCE_INVALID");
});

test("旧任务保持兼容，通用检查明确标为 legacy，不宣称已核验实现依据", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const service = new TaskService(await bindWorktree(fixture.path));
  const task = TaskSchema.parse((await service.open(request)).data), path = join(fixture.path, ".project-dev/local/tasks", `${task.id}.json`);
  const legacy = JSON.parse(await readFile(path, "utf8")); delete legacy.implementation_policy; delete legacy.implementation_bases;
  await writeFile(path, JSON.stringify(legacy));
  const check = (await service.check({})).data as any;
  assert.equal(check.quality.implementation.state, "legacy");
  assert.equal(check.quality.implementation.required, false);
});

test("真实 STDIO 接收通用实现依据，重启后保留决策及未完成验收", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { fileURLToPath } = await import("node:url");
  const connect = async () => {
    const client = new Client({ name: "basis-regression", version: "1" }); t.after(() => client.close());
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.NODE_TEST_CONTEXT;
    await client.connect(new StdioClientTransport({ command: process.execPath, env, args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--project", fixture.path], stderr: "pipe" }));
    return client;
  };
  const first = await connect();
  const opened = await first.callTool({ name: "task_open", arguments: { ...request, implementation_basis: await basis(fixture.path) } });
  assert.equal((opened.structuredContent as any).code, "TASK_OPENED");
  await first.close();
  const second = await connect(), restored = await second.callTool({ name: "task_check", arguments: {} });
  const data = (restored.structuredContent as any).data;
  assert.equal(data.quality.implementation.timing, "before_changes");
  assert.equal(data.quality.implementation.decisions[0].id, "boundary");
  assert.equal(data.quality.implementation.state, "pending");
});

test("新目录的上下文包含通用共享实现，不局限 HTTP，也不套用兄弟目录规范", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const { mkdir } = await import("node:fs/promises");
  const put = async (path: string, text: string) => { await mkdir(join(fixture.path, path, ".."), { recursive: true }); await writeFile(join(fixture.path, path), text); };
  await put("src/shared/policy.ts", "// 策略选择集中维护。\nexport const selectPolicy = (kind: string) => kind;\n");
  await put("src/modules/existing/entry.ts", "import {selectPolicy} from '../../shared/policy';\nexport const select = selectPolicy;\n");
  await put("src/modules/other/AGENTS.md", "# 仅约束兄弟模块的特殊实现要求\n");
  await put("src/modules/new/AGENTS.md", "# 本模块继承项目规范并遵守本地职责边界\n");
  const { UnderstandingService } = await import("../src/understanding/service.js");
  const service = new UnderstandingService(await bindWorktree(fixture.path));
  assert.equal((await service.scan({})).outcome, "ok");
  const context = ((await service.context({ paths: ["src/modules/new/business.ts"] })).data as any).implementation_context;
  assert.ok(context.shared_entries.some((entry: any) => entry.path === "src/shared/policy.ts" && entry.consumers.includes("src/modules/existing/entry.ts")));
  assert.ok(context.project_instructions.some((entry: any) => entry.path === "src/modules/new/AGENTS.md"));
  assert.ok(!context.project_instructions.some((entry: any) => entry.path === "src/modules/other/AGENTS.md"));
});
