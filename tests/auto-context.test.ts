import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { handleHook } from "../src/hooks/handler.js";
import { ContextReceipts } from "../src/context/receipts.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { bindWorktree } from "../src/git/index.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { TaskService } from "../src/task-service.js";
import { interactionStorage } from "../src/workflow/interaction.js";
import { TaskStore } from "../src/storage/task-store.js";

async function setup(t: test.TestContext) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = await mkdtemp(join(tmpdir(), "pda-hook-home-")); t.after(() => rm(home, { recursive: true, force: true }));
  const plugin = new PluginSettings(home), settings = new RuntimeSettings(home);
  await plugin.prepare(fixture.path, { apply: true });
  const binding = await bindWorktree(fixture.path), service = new UnderstandingService(binding);
  await service.scan({});
  const event = { session_id: "conversation-a", turn_id: "turn-a", cwd: fixture.path, hook_event_name: "UserPromptSubmit", prompt: "修改 account 状态功能" };
  const call = (input: object = {}) => handleHook({ ...event, ...input }, "/installed/project-dev-agent", home);
  const mode = async (mode: "manual" | "observe" | "auto") => settings.configure({ apply: true, expected_revision: (await settings.read())?.revision ?? null, mode });
  return { fixture, home, plugin, settings, binding, service, event, call, mode };
}
const context = (result: Record<string, unknown>) => (result.hookSpecificOutput as { additionalContext: string } | undefined)?.additionalContext ?? "";

test("钩子默认手动；observe 不注入，闲聊不建任务，异常范围不扩大配置", async t => {
  const { call, mode, home, plugin } = await setup(t);
  assert.deepEqual(await call(), {});
  await mode("observe"); assert.deepEqual(await call(), {});
  await mode("auto"); assert.deepEqual(await call({ prompt: "你好" }), {});
  const before = await plugin.status();
  assert.deepEqual(await call({ cwd: "/path/does-not-exist" }), {});
  assert.deepEqual(await plugin.status(), before);
  assert.ok((await new DiagnosticWriter(home).read()).events.some(event => event.reason_code === "CONTEXT_UNAVAILABLE"));
});

test("自动上下文同源检索、有限输出、按会话去重，生命周期刷新，回执严格绑定项目与身份", async t => {
  const { call, mode, home, fixture, event } = await setup(t); await mode("auto");
  const first = context(await call()); assert.ok(first.includes("Project Dev Agent")); assert.ok(first.includes("context_id="));
  assert.ok(Buffer.byteLength(first) < 6_500); assert.ok(!first.includes("permissionDecision"));
  assert.ok(context(await call()).includes("与前次相同"));
  await call({ hook_event_name: "SessionStart", source: "compact" });
  assert.ok(!context(await call()).includes("与前次相同"));
  const contextId = /context_id=([a-f0-9]{64})/.exec(first)![1]!;
  const receipts = new ContextReceipts(home);
  assert.equal(await receipts.valid(fixture.path, { session_id: event.session_id, context_id: contextId }), true);
  assert.equal(await receipts.valid(fixture.path, { session_id: "other", context_id: contextId }), false);
  assert.equal(await receipts.valid("/another/project", { session_id: event.session_id, context_id: contextId }), false);
  await call({ hook_event_name: "SessionStart", source: "resume" });
  assert.equal(await receipts.valid(fixture.path, { session_id: event.session_id, context_id: contextId }), false);
  assert.equal(await new TaskStore(fixture.path).active(), undefined);
});

test("自动钩子不扫描或修改业务文件，未扫描项目只提示受控接入入口", async t => {
  const { call, mode, fixture } = await setup(t); await mode("auto");
  await rm(join(fixture.path, ".project-dev/local/understanding"), { recursive: true });
  const before = await readFile(join(fixture.path, "src/account-policy.ts"), "utf8").catch(() => null);
  const output = context(await call()); assert.ok(output.includes("not_scanned"));
  await assert.rejects(readdir(join(fixture.path, ".project-dev/local/understanding")), { code: "ENOENT" });
  assert.equal(await readFile(join(fixture.path, "src/account-policy.ts"), "utf8").catch(() => null), before);
});

test("PRD/SDD 来源核对、任务幂等重试及归属保护共同生效，旧任务仍可显式使用", async t => {
  const { binding, fixture, call, mode } = await setup(t), tasks = new TaskService(binding);
  const input = { requirement: "按现有 SDD 扩展 account 状态", acceptance_criteria: [{ id: "behavior", description: "状态行为符合已有规则" }],
    spec_input: { kind: "sdd", source_ids: ["task-request"] } };
  const owner = { session_id: "conversation-a", operation_id: randomUUID() };
  const run = <T>(action: () => Promise<T>) => interactionStorage.run(owner, action);
  assert.equal((await run(() => tasks.open({ ...input, spec_input: { kind: "prd", source_ids: ["missing"] } }))).code, "SPECIFICATION_SOURCE_INVALID");
  const opened = await run(() => tasks.open(input)); assert.equal(opened.code, "TASK_OPENED");
  const saved = opened.data as { id: string; revision: number; spec_input: { kind: string } }; assert.equal(saved.spec_input.kind, "sdd");
  const repeated = await run(() => tasks.open(input)); assert.equal(repeated.code, "TASK_REUSED"); assert.equal((repeated.data as { id: string }).id, saved.id);
  assert.equal((await run(() => tasks.open({ ...input, requirement: "different operation payload" }))).code, "TASK_OPERATION_CONFLICT");
  assert.equal((await tasks.update({ task_id: saved.id, expected_revision: 0, phase: "aborted", abort_reason: "试图修改另一会话" })).code, "TASK_SESSION_REQUIRED");
  assert.equal((await interactionStorage.run({ session_id: "another" }, () => tasks.check({}))).code, "TASK_SESSION_MISMATCH");
  const status = await new TaskStore(fixture.path).load(saved.id); assert.equal(status.revision, 0); assert.equal(status.phase, "active");
  await mode("auto"); assert.ok(context(await call({ prompt: "继续" })).includes(saved.id));
  assert.deepEqual(await call({ session_id: "another", prompt: "继续" }), {});
  assert.equal((await run(() => tasks.update({ task_id: saved.id, expected_revision: 0, phase: "aborted", abort_reason: "测试完成" }))).outcome, "ok");
  const legacy = await tasks.open({ requirement: "兼容普通明确调用", acceptance_criteria: input.acceptance_criteria });
  assert.equal(legacy.outcome, "ok"); assert.equal((legacy.data as { owner?: unknown }).owner, undefined);
});
