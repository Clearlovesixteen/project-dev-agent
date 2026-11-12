import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { createServer } from "../src/server.js";
import { handleHook } from "../src/hooks/handler.js";
import { hookDiagnosticContext } from "../src/hooks/diagnostic-context.js";
import { classifyCommand } from "../src/hooks/shell-policy.js";
import { DiagnosticContext } from "../src/observability/diagnostic-context.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { ToolResultSchema } from "../src/domain/result.js";

async function setup(t: test.TestContext) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "diagnostic-home"); await mkdir(home);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { upload: false } });
  const plugin = new PluginSettings(home), server = createServer(project => plugin.bind(project), undefined, plugin);
  const client = new Client({ name: "hook-diagnostic-regression", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(() => client.close()); t.after(() => server.close());
  const session = { session_id: "diagnostic-session-private", turn_id: "diagnostic-turn-private" };
  const hook = (input: object, call?: string) => handleHook({ cwd: fixture.path, ...session, ...input }, "/installed/project-dev-agent", home, call ? { trace: call } : {});
  const call = async (name: string, args: Record<string, unknown> = {}) => ToolResultSchema.parse((await client.callTool({ name, arguments: { project: fixture.path, ...args, interaction: session } })).structuredContent);
  const events = async () => (await new DiagnosticWriter(home).read()).events;
  return { fixture, home, plugin, session, hook, call, events };
}

test("纯词法诊断只保留固定能力族/形状，原始程序词、参数、引用和路径均不返回", () => {
  const samples = [
    ["git restore --source=PRIVATE_BRANCH --staged --worktree -- PRIVATE_PATH", "git_restore", "single"],
    ["nl -ba PRIVATE_PATH | sed -n '1,24p'", "number_lines", "pipeline"],
    ["rg PRIVATE_QUERY PRIVATE_PATH > PRIVATE_OUTPUT", "unknown", "redirection"],
    ["git add -- PRIVATE_PATH && node -e PRIVATE_CODE", "unknown", "chain"],
    ["node -e \"$(PRIVATE_COMMAND)\"", "unknown", "dynamic"],
  ] as const;
  for (const [command, family, shape] of samples) {
    const input = { hook_event_name: "PreToolUse" as const, cwd: "/PRIVATE_PROJECT", session_id: "PRIVATE_SESSION", tool_name: "Bash", tool_input: { command } };
    const context = hookDiagnosticContext(input, classifyCommand(command, "posix"));
    assert.equal(context.command_family, family); assert.equal(context.command_shape, shape);
    assert.equal(DiagnosticContext.safeParse(context).success, true); assert.ok(!JSON.stringify(context).includes("PRIVATE"));
  }
});

test("新B未登记的真实钩子记录已有A数量及可执行动作，重试共享operation且每次call不同", async t => {
  const s = await setup(t), second = await createGitFixture(); t.after(second.cleanup);
  await s.call("project_prepare", { apply: true });
  const input = { cwd: second.path, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "private-operation", tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.js\n@@\n+// PRIVATE_CODE\n*** End Patch" } };
  for (const call of ["private-call-1", "private-call-2"]) assert.equal(((await s.hook(input, call)).hookSpecificOutput as any)?.permissionDecision, "deny");
  const events = (await s.events()).filter(event => event.reason_code === "PROJECT_SETUP_REQUIRED");
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.context?.scope_mode, "projects"); assert.equal(event.context?.scope_state, "not_enrolled");
    assert.equal(event.context?.enrolled_project_count, 1); assert.equal(event.context?.required_action, "prepare");
    assert.equal(event.context?.cause_code, "PROJECT_NOT_ENROLLED"); assert.equal(event.context?.decision, "deny");
    assert.equal(event.context?.task_state, undefined, "未读任务不能谎报无任务");
    assert.match(event.call_id!, /^[a-f0-9]{64}$/); assert.match(event.operation_id!, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(events[0]!.call_id, events[1]!.call_id); assert.equal(events[0]!.operation_id, events[1]!.operation_id);
  const raw = JSON.stringify(await s.events()); for (const value of [s.fixture.path, second.path, "PRIVATE_CODE", "private-operation", "private-call-1", s.session.session_id]) assert.ok(!raw.includes(value), value);
});

test("readonly仅关联workdir不冒充项目，身份拒绝记录deny而非成功linked", async t => {
  const s = await setup(t);
  const read = await s.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "private-read", tool_input: { command: "nl -ba PRIVATE_FILE | sed -n '1,24p'" } }, "readonly-call");
  assert.deepEqual(read, {});
  const reading = (await s.events()).find(event => event.event_name === "decision.recorded")!;
  assert.equal(reading.project_id, null); assert.match(reading.workdir_id!, /^[a-f0-9]{64}$/);
  assert.equal(reading.context?.command_family, "number_lines"); assert.equal(reading.context?.command_shape, "pipeline"); assert.equal(reading.context?.decision, "allow");
  assert.equal(reading.context?.scope_state, undefined);
  const rejected = await s.hook({ hook_event_name: "PreToolUse", tool_name: "mcp__project_dev__task_open", tool_input: { project: s.fixture.path, interaction: { session_id: "forged-owner" } } }, "identity-call");
  assert.equal((rejected.hookSpecificOutput as any)?.permissionDecision, "deny");
  const rejection = (await s.events()).find(event => event.reason_code === "MCP_IDENTITY_REJECTED")!;
  assert.equal(rejection.outcome, "incomplete"); assert.equal(rejection.context?.decision, "deny"); assert.equal(rejection.context?.stage, "owner");
  assert.equal(rejection.context?.task_state, undefined); assert.ok(!JSON.stringify(await s.events()).includes("PRIVATE_FILE"));
});

test("真实MCP准备任务后门禁报告已观测context/task/basis/target；日志挂起不改变允许或拒绝", async t => {
  const s = await setup(t); await s.call("project_prepare", { apply: true }); await s.call("project_scan");
  await s.call("project_context", { query: "authentication", paths: ["src/auth.js"] });
  const write = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "planned-write", tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.js\n@@\n+// approved\n*** End Patch" } };
  assert.equal(((await s.hook(write, "missing-task-call")).hookSpecificOutput as any)?.permissionDecision, "deny");
  const missing = (await s.events()).find(event => event.reason_code === "TASK_BINDING_REQUIRED")!;
  assert.equal(missing.context?.task_state, "missing"); assert.equal(missing.context?.context_state, "ready"); assert.equal(missing.context?.required_action, "open_task");
  const opened = await s.call("task_open", await withImplementationBasis(s.fixture.path, { requirement: "为现有认证逻辑补注释", acceptance_criteria: [{ id: "comment", description: "认证逻辑不变" }] }));
  const task = opened.data as any; assert.equal(opened.outcome, "ok");
  await s.call("task_update", { task_id: task.id, expected_revision: 0, change_items: [{ id: "auth", target_path: "src/auth.js", action: "modify", requirement: "补注释", rationale: "沿用现有认证", sources: [{ kind: "code", reference: "src/auth.js" }] }] });
  assert.notEqual(((await s.hook(write, "ready-call")).hookSpecificOutput as any)?.permissionDecision, "deny");
  const ready = (await s.events()).find(event => event.reason_code === "WRITE_READY")!;
  assert.deepEqual({ stage: ready.context?.stage, decision: ready.context?.decision, context: ready.context?.context_state, task: ready.context?.task_state,
    basis: ready.context?.basis_state, target: ready.context?.target_scope, count: ready.context?.target_count },
  { stage: "ready", decision: "allow", context: "ready", task: "owned", basis: "ready", target: "within", count: 1 });
  const last = (await s.events()).find(event => event.call_id === ready.call_id && event.event_name === "hook.finished")!; assert.equal(last.operation_id, ready.operation_id);
  const previous = DiagnosticWriter.prototype.record; DiagnosticWriter.prototype.record = async () => new Promise(() => {}); t.after(() => { DiagnosticWriter.prototype.record = previous; });
  const began = performance.now(); assert.notEqual(((await s.hook(write)).hookSpecificOutput as any)?.permissionDecision, "deny");
  const denied = await s.hook({ ...write, tool_input: { command: "*** Begin Patch\n*** Update File: src/service.js\n@@\n+// unplanned\n*** End Patch" } });
  assert.equal((denied.hookSpecificOutput as any)?.permissionDecision, "deny");
  const hungDuration = performance.now() - began;
  assert.ok(hungDuration < 2500, "诊断挂起不能等到宿主硬期限才返回真实门禁结果");
  DiagnosticWriter.prototype.record = async () => { throw new Error("PRIVATE_LOGGER_FAILURE"); };
  assert.notEqual(((await s.hook(write)).hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.equal(((await s.hook({ ...write, tool_input: { command: "*** Begin Patch\n*** Update File: src/service.js\n@@\n+// unplanned\n*** End Patch" } })).hookSpecificOutput as any)?.permissionDecision, "deny");
  t.diagnostic(`hung diagnostics: allow+deny=${Math.round(hungDuration)}ms; throwing diagnostics preserve both results`);
});
