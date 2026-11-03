import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { RuntimeSettings, DIAGNOSTIC_NOTICE } from "../src/runtime/config.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { handleHook } from "../src/hooks/handler.js";
import { DiagnosticWriter, observeTool } from "../src/observability/writer.js";
import { uploadDiagnostics } from "../src/observability/uploader.js";
import { summarizeEvents, renderInsights } from "../src/observability/insights.js";
import { hookFailure } from "../src/hooks/project.js";

async function temporaryHome(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pda-reliability-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("自动钩子在工作范围外正常跳过，不把其他项目计作上下文故障或扩大配置", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const other = await createGitFixture(); t.after(other.cleanup);
  const home = await temporaryHome(t);
  await new PluginSettings(home).prepare(fixture.path, { apply: true });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto" });
  const prior = await readFile(join(home, "project-dev-agent/settings.json"), "utf8");
  const output = await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "outside-session", cwd: other.path, prompt: "修复这个项目" }, fixture.path, home);
  assert.deepEqual(output, {});
  assert.equal(await readFile(join(home, "project-dev-agent/settings.json"), "utf8"), prior);
  const event = (await new DiagnosticWriter(home).read()).events.find(event => event.event_name === "hook.finished");
  assert.equal(event?.outcome, "skipped");
  assert.equal(event?.reason_code, "PROJECT_OUTSIDE_WORKSPACE");
});

test("auto 首次使用 Git 项目能给出初始化入口，钩子本身不擅自保存项目配置", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = await temporaryHome(t);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto" });
  const output = await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "first-session", cwd: fixture.path, prompt: "修复这里的功能" }, fixture.path, home);
  const context = (output.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
  assert.ok(context?.includes("project_prepare"), "首次自动开发仍须可进入已授权的项目初始化");
  await assert.rejects(readFile(join(home, "project-dev-agent/settings.json")), { code: "ENOENT" });
  assert.ok(!(await new DiagnosticWriter(home).read()).events.some(event => event.outcome === "degraded"));
});

test("非 Git 聊天目录正常跳过，真实目录读取失败保留可定位的安全原因", async t => {
  const home = await temporaryHome(t), cwd = await temporaryHome(t);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto" });
  await handleHook({ hook_event_name: "SessionStart", session_id: "non-project", cwd }, cwd, home);
  await handleHook({ hook_event_name: "SessionStart", session_id: "missing-project", cwd: join(cwd, "private-missing-directory") }, cwd, home);
  const events = (await new DiagnosticWriter(home).read()).events.filter(event => event.event_name === "hook.finished");
  assert.equal(events[0]?.outcome, "skipped");
  assert.equal(events[0]?.reason_code, "NOT_GIT_WORKTREE");
  assert.equal(events[1]?.outcome, "degraded");
  assert.equal(events[1]?.reason_code, "HOOK_CWD_UNAVAILABLE");
  assert.ok(!JSON.stringify(events).includes("private-missing-directory"));
});

test("observe 首次接入不注入初始化指令，未知异常只记录固定阶段码", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = await temporaryHome(t);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "observe" });
  const result = await handleHook({ hook_event_name: "SessionStart", session_id: "observe-first", cwd: fixture.path }, fixture.path, home);
  assert.deepEqual(result, {});
  assert.equal(hookFailure({ code: "PRIVATE_CUSTOM_MESSAGE", message: "/private/project" }, "context").reason, "HOOK_CONTEXT_LOOKUP_FAILED");
  assert.equal(hookFailure({ code: "GIT_COMMAND_FAILED" }, "scope").outcome, "degraded");
});

test("验收语义事件保留主调用原因，不再记录 incomplete / OK", async t => {
  const home = await temporaryHome(t), writer = new DiagnosticWriter(home);
  await observeTool(writer, "task_check", undefined, async () => ({ outcome: "incomplete", code: "REVIEW_STALE" }));
  const events = (await writer.read()).events;
  assert.equal(events.find(event => event.event_name === "quality.checked")?.reason_code, "REVIEW_STALE");
});

test("历史 incomplete / OK 派生事件不会把同一验收信号统计两次", async t => {
  const home = await temporaryHome(t), writer = new DiagnosticWriter(home);
  await observeTool(writer, "task_check", undefined, async () => ({ outcome: "incomplete", code: "REVIEW_STALE" }));
  const legacy = (await writer.read()).events.map(event => event.event_name === "quality.checked" ? { ...event, reason_code: "OK" } : event);
  const report = summarizeEvents(legacy, { invalid: 0, truncated: false });
  assert.equal(report.sample_events, 2);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]?.occurrences, 1);
  assert.ok(report.issues[0]?.key.endsWith("REVIEW_STALE"));
});

test("不同项目或存在并发歧义时保留异常信号，不跨上下文消除重复", async t => {
  const home = await temporaryHome(t), writer = new DiagnosticWriter(home);
  await observeTool(writer, "task_check", undefined, async () => ({ outcome: "incomplete", code: "REVIEW_STALE" }));
  const events = (await writer.read()).events;
  const differentProject = events.map(event => event.event_name === "quality.checked" ? { ...event, project_id: "a".repeat(64) } : event);
  assert.equal(summarizeEvents(differentProject, { invalid: 0, truncated: false }).signal_coverage.excluded_derived_events, 0);
  const main = events.find(event => event.event_name === "tool.finished")!;
  const ambiguous = [main, { ...main, event_id: "another-main" }, ...events.filter(event => event.event_name !== "tool.finished")];
  assert.equal(summarizeEvents(ambiguous, { invalid: 0, truncated: false }).signal_coverage.excluded_derived_events, 0);
});

test("一次有界发送可以清理多批积压，每批最多 50 条并在确认后保存游标", async t => {
  const home = await temporaryHome(t), writer = new DiagnosticWriter(home);
  const batches: number[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    batches.push(body.events.length);
    response.end(JSON.stringify({ batch_id: body.batch_id, acknowledged: body.events.length }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, diagnostics: {
    upload: true, notice_version: DIAGNOSTIC_NOTICE,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/events`, write_token: "isolated-regression-token" } });
  for (let index = 0; index < 121; index++) await writer.record("health.checked");
  const result = await uploadDiagnostics(home, 1500);
  assert.equal(result.sent, 121);
  assert.deepEqual(batches, [50, 50, 21]);
  assert.equal((await uploadDiagnostics(home, 1500)).sent, 0);
});

test("诊断 HTML 说明链路明细的展示上限，不能用事件未截断掩盖链路截断", async t => {
  const home = await temporaryHome(t), writer = new DiagnosticWriter(home);
  await writer.record("health.checked");
  const event = (await writer.read()).events[0]!;
  const events = Array.from({ length: 201 }, (_, index) => ({ ...event, trace_id: index.toString(16).padStart(64, "0") }));
  const report = summarizeEvents(events, { invalid: 0, truncated: false });
  assert.equal(report.traces_truncated, true);
  assert.ok(/201.*200|200.*201/s.test(renderInsights(report)), "报告必须同时写明 201 条总链路和 200 条展示上限");
});
