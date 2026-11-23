import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { bindWorktree } from "../src/git/index.js";
import { publishModelShadow } from "../src/project-knowledge/service.js";

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

/** 通过正常 MCP 入口为指定工作树准备实施依据和范围，钩子测试不伪造就绪记录。 */
async function prepareAuthWrite(s: Awaited<ReturnType<typeof setup>>, project = s.fixture.path) {
  assert.equal((await s.call("project_prepare", { project, apply: true })).outcome, "ok");
  assert.equal((await s.call("project_scan", { project })).outcome, "ok");
  assert.notEqual((await s.call("project_context", { project, paths: ["src/auth.js"] })).outcome, "error");
  const opened = await s.call("task_open", { project, ...await withImplementationBasis(project, {
    requirement: "在认证入口补充说明", acceptance_criteria: [{ id: "auth", description: "认证行为符合已有约定" }],
  }) });
  assert.equal(opened.code, "TASK_OPENED", JSON.stringify(opened));
  const task = opened.data as { id: string; revision: number };
  assert.equal((await s.call("task_update", { project, task_id: task.id, expected_revision: task.revision, change_items: [{
    id: "auth", target_path: "src/auth.js", action: "modify", requirement: "补充认证入口说明", rationale: "沿用已有认证入口",
    sources: [{ kind: "code", reference: "src/auth.js" }],
  }] })).code, "TASK_UPDATED");
}

const patchFor = (...paths: string[]) => "*** Begin Patch\n" + paths.map(path => `*** Update File: ${path}\n@@\n+// 已计划的认证说明`).join("\n") + "\n*** End Patch";
const denied = (result: Record<string, unknown>) => (result.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";

test("查看有歧义的无关模型和符号详情后，当前任务的已查实依据仍可用于写入", async t => {
  const s = await setup(t);
  const binding = await bindWorktree(s.fixture.path);
  for (const sha256 of ["a".repeat(64), "b".repeat(64)]) await publishModelShadow(binding, {
    id: "unrelated", module: "other", revision: 1, related_versions: [{ path: "src/service.js", sha256 }],
  });
  await prepareAuthWrite(s);
  const store = new ParticipationStore(s.home);
  const before = await store.read(binding.root, s.session, binding.branch);
  assert.equal(before?.context_ready, true);
  const lookup = await s.call("project_context", { model_id: "unrelated" });
  assert.equal(lookup.outcome, "incomplete");
  const bySymbol = await s.call("project_context", { code_locations: [{ path: "src/auth.js", symbol: "unknownSymbol" }] });
  assert.notEqual(bySymbol.outcome, "error");
  const after = await store.read(binding.root, s.session, binding.branch);
  assert.equal(after?.context_id, before?.context_id);
  const write = await s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "after-lookups", tool_input: { patch: patchFor("src/auth.js") } });
  assert.equal(denied(write), false, JSON.stringify(write));
});

test("当前任务在同仓库工作树 B，前后钩子核对实际目标并拒绝混合工作树和链接跳转", async t => {
  const s = await setup(t);
  assert.equal((await s.call("project_prepare", { apply: true })).outcome, "ok");
  const alias = join(s.fixture.root, "next-worktree");
  execFileSync("git", ["worktree", "add", "-b", "next-worktree", alias], { cwd: s.fixture.path, stdio: "pipe" });
  const project = await realpath(alias);
  await prepareAuthWrite(s, project);

  const input = { tool_name: "apply_patch", tool_use_id: "worktree-b", tool_input: { patch: patchFor(join(alias, "src/auth.js")) } };
  const guard = await s.hook({ hook_event_name: "PreToolUse", ...input });
  assert.equal(denied(guard), false, JSON.stringify(guard));
  await s.hook({ hook_event_name: "PostToolUse", ...input, tool_response: "Success" });
  const store = new ParticipationStore(s.home);
  assert.equal((await store.status(project, s.session)).write_tool_calls, 1);
  assert.equal((await store.status(s.fixture.path, s.session)).write_tool_calls, 0);
  const withToolDirectory = await s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "tool-workdir",
    tool_input: { workdir: project, patch: patchFor("src/auth.js") } });
  assert.equal(denied(withToolDirectory), false, JSON.stringify(withToolDirectory));

  const mixed = await s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "mixed",
    tool_input: { patch: patchFor("src/auth.js", join(project, "src/auth.js")) } });
  assert.equal(denied(mixed), true);
  assert.match(JSON.stringify(mixed), /多个.*工作树/);
  await symlink(project, join(s.fixture.path, "alias-inside"));
  const linked = await s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "unsafe-link",
    tool_input: { patch: patchFor("alias-inside/src/auth.js") } });
  assert.equal(denied(linked), true);
  // 即使链接绕回当前工作树，工作树内部的符号链接也不作为补丁别名。
  await symlink(s.fixture.root, join(s.fixture.path, "parent-alias"));
  const loop = await s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "same-worktree-link",
    tool_input: { patch: patchFor(join("parent-alias", basename(s.fixture.path), "src/auth.js")) } });
  assert.equal(denied(loop), true);
  assert.match(JSON.stringify(loop), /符号链接/);
  const other = await createGitFixture(); t.after(other.cleanup);
  const outside = await s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "different-repository",
    tool_input: { patch: patchFor(join(other.path, "src/auth.js")) } });
  assert.equal(denied(outside), true);
  assert.match(JSON.stringify(outside), /仓库/);
});

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

test("正常写入复用当前源码的依据，配置变化和会话压缩分别撤销旧资格", async t => {
  const s = await setup(t);
  await prepareAuthWrite(s);
  const store = new ParticipationStore(s.home), binding = await bindWorktree(s.fixture.path);
  const guard = (id: string) => s.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_use_id: id, tool_input: { patch: patchFor("src/auth.js") } });
  assert.equal(denied(await guard("one")), false);
  const first = await store.read(binding.root, s.session, binding.branch);
  assert.match(first!.basis_receipt!, /^[0-9a-f]{64}$/);
  assert.equal(denied(await guard("two")), false);
  assert.equal((await store.read(binding.root, s.session, binding.branch))?.basis_receipt, first!.basis_receipt);
  // 同一任务、同一个缓存：项目配置已排除原证据时必须拒绝。
  await writeFile(join(s.fixture.path, ".project-dev/project.yaml"), 'schema_version: 1\nexclude_paths: ["AGENTS.md"]\n');
  assert.match(JSON.stringify(await guard("excluded")), /依据来源已失效/);
  await s.hook({ hook_event_name: "SessionStart", source: "compact" });
  const compacted = await store.read(binding.root, s.session, binding.branch);
  assert.equal(compacted?.context_ready, false); assert.equal(compacted?.basis_receipt, null);
  assert.deepEqual(compacted?.pending_tools, ["one", "two"]);
  assert.match(JSON.stringify(await guard("compact")), /project_context/);
});

test("跨轮续接不触发完整审查；保留待验收计数和范围，正式检查独立执行", async t => {
  const s = await setup(t); await prepareAuthWrite(s);
  const patch = { tool_name: "apply_patch", tool_use_id: "plan-write", tool_input: { patch: patchFor("src/auth.js") } };
  assert.equal(denied(await s.hook({ hook_event_name: "PreToolUse", ...patch })), false);
  await s.hook({ hook_event_name: "PostToolUse", ...patch, tool_response: "Success" });
  s.session.turn_id = "another-turn";
  const resume = await s.call("task_check", { mode: "resume" });
  assert.equal(resume.code, "TASK_CONTINUATION_READY");
  assert.equal((resume.data as any).quality_checked, false);
  assert.equal((resume.data as any).review_snapshot, undefined);
  const status = await new ParticipationStore(s.home).status(s.fixture.path, s.session);
  assert.equal(status.state, "check_required"); assert.equal(status.checked_write_tool_calls, 0);
  assert.equal(denied(await s.hook({ hook_event_name: "PreToolUse", ...patch, tool_use_id: "continued" })), false);
  assert.equal(denied(await s.hook({ hook_event_name: "PreToolUse", ...patch, tool_input: { patch: patchFor("unplanned.txt") } })), true);
  const review = await s.call("task_check");
  assert.equal(typeof (review.data as any).review_snapshot, "string");
  const events = (await new DiagnosticWriter(s.home).read()).events;
  assert.ok(events.some(event => event.reason_code === "TASK_CONTINUATION_READY" && event.event_name === "tool.finished"));
  assert.ok(!events.some(event => event.reason_code === "TASK_CONTINUATION_READY" && event.event_name === "quality.checked"));
});

test("只补本插件身份，拒绝伪装会话；旧 manual 自动迁移后保留新版停用选择", async t => {
  const s = await setup(t);
  const other = await s.hook({ hook_event_name: "PreToolUse", tool_name: "mcp__other__task_open", tool_input: { text: "other plugin" } });
  assert.deepEqual(other, {});
  const forged = await s.hook({ hook_event_name: "PreToolUse", tool_name: "mcp__project_dev__task_open", tool_input: { project: s.fixture.path, interaction: { session_id: "another-owner" } } });
  assert.equal((forged.hookSpecificOutput as any)?.permissionDecision, "deny");
  const path = join(s.home, "project-dev-agent/runtime.json"), legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.mode = "manual"; delete legacy.mode_origin; delete legacy.activation_policy_version; await writeFile(path, JSON.stringify(legacy));
  const migrated = await s.hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.match((migrated.hookSpecificOutput as any)?.additionalContext, /Project Dev Agent 自动参与入口/);
  assert.equal((await s.settings.status()).activation.state, "enabled");
  assert.equal((await s.settings.current()).mode, "auto");
  await s.settings.configure({ apply: true, expected_revision: (await s.settings.current()).revision, mode: "manual" });
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
