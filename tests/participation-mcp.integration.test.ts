import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { createServer } from "../src/server.js";
import { handleHook } from "../src/hooks/handler.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { ParticipationStore } from "../src/workflow/participation.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { TaskStore } from "../src/storage/task-store.js";

async function setup(t: test.TestContext) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = await mkdtemp(join(tmpdir(), "pda-native-flow-")); t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new RuntimeSettings(home);
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { upload: false } });
  const plugin = new PluginSettings(home), server = createServer(project => plugin.bind(project), undefined, plugin);
  const client = new Client({ name: "native-participation-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(() => client.close()); t.after(() => server.close());
  let sequence = 0;
  const session = { session_id: "native-owner", turn_id: "native-turn" };
  const hook = (input: object) => handleHook({ cwd: fixture.path, ...session, ...input }, "/installed/project-dev-agent", home);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const original = { project: fixture.path, ...args };
    const prepared = await hook({ hook_event_name: "PreToolUse", tool_name: `mcp__project_dev__${name}`, tool_input: original, tool_use_id: `mcp-${sequence++}` });
    const native = prepared.hookSpecificOutput as { updatedInput?: Record<string, unknown>; permissionDecision?: string } | undefined;
    assert.notEqual(native?.permissionDecision, "deny", JSON.stringify(prepared));
    const result = await client.callTool({ name, arguments: native?.updatedInput ?? original });
    return ToolResultSchema.parse(result.structuredContent);
  };
  return { fixture, home, settings, plugin, hook, call, session };
}

test("原生身份 → 实际 MCP 上下文与任务 → 修改前检查 → 修改后检查完整贯通", async t => {
  const s = await setup(t);
  const prepared = await s.call("project_prepare", { apply: true }); assert.equal(prepared.outcome, "ok");
  assert.equal((prepared.data as any).participation.state, "unobserved");
  assert.equal((await s.call("project_scan")).outcome, "ok");
  assert.notEqual((await s.call("project_context", { query: "account auth", paths: ["src/auth.js"] })).outcome, "error");
  const input = await withImplementationBasis(s.fixture.path, {
    requirement: "核对现有认证模块，追加说明注释", acceptance_criteria: [{ id: "a", description: "认证逻辑保持有效且注释清楚" }],
  });
  const opened = await s.call("task_open", input); assert.equal(opened.code, "TASK_OPENED", JSON.stringify(opened));
  const task = opened.data as any; assert.equal(task.owner.session_id, s.session.session_id);
  assert.equal((await s.call("task_open", input)).code, "TASK_REUSED");
  assert.equal((await s.call("task_update", { task_id: task.id, expected_revision: 0, change_items: [{
    id: "auth", target_path: "src/auth.js", action: "modify", requirement: "补充认证说明", rationale: "沿用已有认证实现和入口",
    sources: [{ kind: "code", reference: "src/auth.js" }],
  }] })).outcome, "ok");
  const write = { tool_name: "apply_patch", tool_use_id: "actual-patch", tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.js\n@@\n+// 认证说明\n*** End Patch" } };
  const unplanned = await s.hook({ hook_event_name: "PreToolUse", ...write, tool_input: { command: "*** Begin Patch\n*** Update File: src/service.js\n@@\n+// 不属于本次范围\n*** End Patch" } });
  assert.equal((unplanned.hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.match((unplanned.hookSpecificOutput as any)?.permissionDecisionReason, /修改清单/);
  const guard = await s.hook({ hook_event_name: "PreToolUse", ...write });
  assert.equal((guard.hookSpecificOutput as any)?.permissionDecision, undefined, JSON.stringify(guard));
  const path = join(s.fixture.path, "src/auth.js"); await writeFile(path, (await readFile(path, "utf8")) + "\n// 认证说明\n");
  await s.hook({ hook_event_name: "PostToolUse", ...write, tool_response: "Success" });
  const store = new ParticipationStore(s.home);
  assert.equal((await store.status(s.fixture.path, s.session)).state, "check_required");
  await s.call("task_check");
  const status = await store.status(s.fixture.path, s.session);
  assert.equal(status.write_tool_calls, 1); assert.equal(status.checked_write_tool_calls, 1);
  assert.equal(status.state, "incomplete", "完成检查不等于全部验收通过");
  const events = (await new DiagnosticWriter(s.home).read()).events;
  assert.ok(events.some(event => event.reason_code === "WRITE_READY"));
  assert.ok(events.some(event => event.event_name === "task.transitioned" && event.attributes.phase === "active"));
  assert.ok(events.filter(event => event.event_name === "tool.finished" && event.attributes.tool !== "plugin_status").every(event => event.session_id));
  assert.ok(!JSON.stringify(events).includes(input.requirement));
  assert.ok(!JSON.stringify(events).includes(s.fixture.path));
  s.session.turn_id = "next-turn";
  const nextTurn = await s.hook({ hook_event_name: "PreToolUse", ...write });
  assert.equal((nextTurn.hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.match((nextTurn.hookSpecificOutput as any)?.permissionDecisionReason, /本轮尚未核对任务/);
});

test("只补本插件身份，拒绝伪装会话；旧 manual 提示迁移且原配置字节不变", async t => {
  const s = await setup(t);
  const other = await s.hook({ hook_event_name: "PreToolUse", tool_name: "mcp__other__task_open", tool_input: { text: "other plugin" } });
  assert.deepEqual(other, {});
  const forged = await s.hook({ hook_event_name: "PreToolUse", tool_name: "mcp__project_dev__task_open", tool_input: { project: s.fixture.path, interaction: { session_id: "another-owner" } } });
  assert.equal((forged.hookSpecificOutput as any)?.permissionDecision, "deny");
  const path = join(s.home, "project-dev-agent/runtime.json"), legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.mode = "manual"; delete legacy.mode_origin; await writeFile(path, JSON.stringify(legacy));
  const before = await readFile(path, "utf8");
  const migrated = await s.hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.match(String(migrated.systemMessage), /manual.*未开启/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await s.settings.status()).activation.state, "migration_required");
  await s.settings.configure({ apply: true, expected_revision: legacy.revision, mode: "manual" });
  assert.equal((await s.settings.status()).activation.state, "disabled");
  assert.deepEqual(await s.hook({ hook_event_name: "SessionStart", source: "startup" }), {});
});

test("显式挂起保留记录，恢复会检查冲突和会话归属，不自动中止其他任务", async t => {
  const s = await setup(t); await s.call("project_prepare", { apply: true });
  const input = { requirement: "保留可恢复的原始任务", acceptance_criteria: [{ id: "a", description: "任务可恢复" }] };
  const opened = await s.call("task_open", input), original = opened.data as any;
  const suspended = await s.call("task_update", { task_id: original.id, expected_revision: 0, phase: "suspended", suspend_reason: "当前任务暂停，先处理独立需求" });
  assert.equal(suspended.code, "TASK_SUSPENDED", JSON.stringify(suspended));
  // 新需求来自后续轮次，保持相同会话但不复用原轮次的幂等 ID。
  s.session.turn_id = "second-turn";
  const second = await s.call("task_open", { ...input, requirement: "处理另一个独立需求" }); assert.equal(second.code, "TASK_OPENED");
  assert.equal((await s.call("task_update", { task_id: original.id, expected_revision: 1, phase: "active" })).code, "ACTIVE_TASK_EXISTS");
  const next = second.data as any;
  assert.equal((await s.call("task_update", { task_id: next.id, expected_revision: 0, phase: "aborted", abort_reason: "回归测试完成，恢复原始任务" })).outcome, "ok");
  const resumed = await s.call("task_update", { task_id: original.id, expected_revision: 1, phase: "active" });
  assert.equal(resumed.code, "TASK_RESUMED", JSON.stringify(resumed));
  const saved = await new TaskStore(s.fixture.path).load(original.id);
  assert.equal(saved.lifecycle?.length, 2); assert.equal(saved.baseline_head, original.baseline_head);
  assert.equal(saved.lifecycle?.[0]?.reason, "当前任务暂停，先处理独立需求");
});

test("查询历史任务不覆盖本会话当前任务，也不记为本轮开发已完成", async t => {
  const s = await setup(t); await s.call("project_prepare", { apply: true });
  const input = { requirement: "保留历史任务供只读查询", acceptance_criteria: [{ id: "a", description: "历史查询保持只读" }] };
  const original = (await s.call("task_open", input)).data as any;
  await s.call("task_update", { task_id: original.id, expected_revision: 0, phase: "aborted", abort_reason: "结束原任务，保留原记录作为历史" });
  s.session.turn_id = "current-turn";
  const current = (await s.call("task_open", { ...input, requirement: "处理当前独立需求" })).data as any;
  const store = new ParticipationStore(s.home);
  assert.equal((await store.status(s.fixture.path, s.session)).task_id, current.id);
  assert.equal((await s.call("task_check", { task_id: original.id })).code, "TASK_INACTIVE");
  const status = await store.status(s.fixture.path, s.session);
  assert.equal(status.task_id, current.id);
  assert.equal(status.state, "task_bound");
});
