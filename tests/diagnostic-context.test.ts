import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticWriter, observeTool } from "../src/observability/writer.js";
import { DiagnosticContext } from "../src/observability/diagnostic-context.js";
import { inputDiagnosticContext, toolDiagnosticContext } from "../src/observability/tool-context.js";
import { DiagnosticEvent, LegacyDiagnosticEvent } from "../src/observability/contracts.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { interactionStorage } from "../src/workflow/interaction.js";

async function setup(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pda-context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, writer: new DiagnosticWriter(home) };
}

test("默认上下文只允许观测事实；原始命令、错误、正文和路径不能混入", () => {
  for (const extra of [{ command: "git restore private-file" }, { message: "Bearer secret" }, { cwd: "/Users/private" }, { prompt: "private PRD" }, { command_family: "private-program" }])
    assert.equal(DiagnosticContext.safeParse({ version: 1, ...extra }).success, false);
  const ctx = toolDiagnosticContext("task_open", inputDiagnosticContext("task_open", { requirement: "private PRD", task_kind: "development" }), { outcome: "error", code: "UNMERGED_CHANGES" });
  assert.equal(ctx.merge_state, "unmerged"); assert.equal(ctx.required_action, "open_merge_recovery");
  assert.equal(ctx.task_state, undefined, "普通open冲突错误不能伪造已读取活跃任务");
  assert.ok(!JSON.stringify(ctx).includes("private"));
});

test("真实writer保留上下文与调用关联，只对标识做HMAC，主调用/派生事件共用call", async t => {
  const { writer } = await setup(t);
  await interactionStorage.run({ session_id: "private-session", turn_id: "private-turn", operation_id: "986f04ea-f0ec-4bff-bfa4-bf2d5a1fd612" }, async () => {
    await observeTool(writer, "task_open", "/Users/private/project", async () => ({ outcome: "ok", code: "TASK_OPENED", data: {
      id: "private-task", phase: "active", requirement: "private PRD", owner: { session_id: "private-session", actor_id: "main" },
      workspace_baseline: { merge_recovery: { version: 1, conflicts: [{ path: "private-code.js" }], source: { reference: "secret-branch" } } },
    } }), "mcp", { context: inputDiagnosticContext("task_open", { task_kind: "merge_recovery" }) });
  });
  const events = (await writer.read()).events; assert.equal(events.length, 2);
  assert.ok(events[0]!.call_id); assert.equal(events[0]!.call_id, events[1]!.call_id);
  assert.equal(events[0]!.context?.task_kind, "merge_recovery"); assert.equal(events[0]!.context?.task_state, "owned");
  assert.equal(events[0]!.context?.initial_conflict_count, 1); assert.equal(events[0]!.context?.recovery_source, "selected");
  assert.equal(events[0]!.context?.node_version, process.versions.node);
  assert.equal(DiagnosticEvent.safeParse(events[0]).success, true); assert.equal(LegacyDiagnosticEvent.safeParse(events[0]).success, false);
  const serialized = JSON.stringify(events);
  for (const value of ["private-session", "private-turn", "private-task", "private-code", "secret-branch", "/Users/private", "private PRD"])
    assert.ok(!serialized.includes(value), value);
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event)) <= 4096));
});

test("失败工具上下文区分恢复入口与普通任务，缺失状态不补猜", async t => {
  const { writer } = await setup(t);
  for (const task_kind of ["development", "merge_recovery"])
    await observeTool(writer, "task_open", undefined, async () => ({ outcome: "error", code: "UNMERGED_CHANGES" }), "mcp", { context: inputDiagnosticContext("task_open", { task_kind }) });
  const events = (await writer.read()).events;
  assert.deepEqual(events.map(event => event.context?.required_action), ["open_merge_recovery", "resolve_conflicts"]);
  assert.notEqual(events[0]!.call_id, events[1]!.call_id);
  assert.ok(events.every(event => event.context?.task_state === undefined));
});

test("范围失败不记成已接入，身份未知不冒充当前owner；无效上下文不能改变业务返回", async t => {
  const { writer } = await setup(t);
  const ctx = toolDiagnosticContext("project_prepare", undefined, { outcome: "error", code: "PROJECT_NOT_ENROLLED" });
  assert.equal(ctx.scope_state, "not_enrolled"); assert.equal(ctx.required_action, "prepare");
  assert.equal(toolDiagnosticContext("project_prepare", undefined, { outcome: "ok", data: { project: "/private/project", state_ignored: false, plugin_setup: { action: "would_initialize" } } }).scope_state, "not_enrolled");
  const unknownOwner = toolDiagnosticContext("task_check", undefined, { outcome: "incomplete", data: { recorded_task: { id: "task", owner: { session_id: "s" }, phase: "active" } } });
  assert.equal(unknownOwner.task_state, undefined);
  assert.equal(toolDiagnosticContext("project_context", undefined, { outcome: "incomplete", data: { state: "needs_review" } }).lookup_state, "needs_review");
  assert.equal(toolDiagnosticContext("project_context", undefined, { outcome: "ok", data: { state: "future_state" } }).context_state, undefined);
  const result = { outcome: "ok", code: "OK", data: { phase: "not-a-phase" } };
  assert.equal(await observeTool(writer, "task_update", undefined, async () => result, "mcp", { context: { version: 1, command_family: "private-name" } as never }), result);
});

test("关闭本地诊断后新增上下文也不落盘，旧无上下文事件仍可读取", async t => {
  const { home, writer } = await setup(t);
  assert.equal(await writer.record("health.checked"), true);
  const old = (await writer.read()).events[0]!; assert.equal(old.context, undefined); assert.equal(old.call_id, undefined);
  assert.equal(LegacyDiagnosticEvent.safeParse(old).success, true);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, diagnostics: { local: false } });
  assert.equal(await writer.record("participation.checked", { context: { version: 1, stage: "task", decision: "deny" } }), false);
  assert.equal((await writer.read()).events.length, 1);
});


test("上下文提取或写入故障不改变业务返回或原始异常", async t => {
  const { writer } = await setup(t);
  const opaqueResult = Object.defineProperty({}, "structuredContent", { get() { throw new Error("diagnostic extraction unavailable"); } });
  assert.equal(await observeTool(writer, "task_check", undefined, async () => opaqueResult), opaqueResult);
  const brokenWriter = Object.create(writer) as DiagnosticWriter;
  brokenWriter.record = async () => { throw new Error("diagnostic disk unavailable"); };
  const result = { outcome: "ok", code: "TASK_OPENED" };
  assert.equal(await observeTool(brokenWriter, "task_open", undefined, async () => result), result);
  const failure = Object.assign(new Error("original business failure"), { code: "UNMERGED_CHANGES" });
  await assert.rejects(observeTool(brokenWriter, "task_open", undefined, async () => { throw failure; }), error => error === failure);
});


test("模型等非任务结果的id不能伪装成任务状态", () => {
  for (const tool of ["project_model_record", "project_feedback_record", "experience_propose"]) {
    const context = toolDiagnosticContext(tool, undefined, { outcome: "ok", data: { id: "record-id", phase: "active", change_items: [] } });
    assert.equal(context.task_state, undefined);
    assert.equal(context.task_kind, undefined);
    assert.equal(context.task_phase, undefined);
    assert.equal(context.planned_count, undefined);
  }
});
