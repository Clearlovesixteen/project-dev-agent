import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { DiagnosticEvent, type TelemetryEvent } from "../src/observability/contracts.js";
import { derivedToolEvents } from "../src/observability/event-links.js";
import { summarizeEvents, renderInsights } from "../src/observability/insights.js";
import { contextDescription } from "../src/observability/context-labels.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const install = randomUUID(), session = hash("session"), project = hash("project"), trace = hash("turn");
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 12) + seconds * 1000).toISOString();
function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return DiagnosticEvent.parse({ schema_version: 1, event_id: randomUUID(), occurred_at: at(0), upload_epoch: null,
    event_name: "tool.finished", install_id: install, session_id: session, project_id: project, trace_id: trace, task_id: null,
    runtime_version: "0.13.6", policy_version: 1, mode: "auto", outcome: "incomplete", reason_code: "TASK_BINDING_REQUIRED",
    duration_ms: 1, evidence_level: "observed", attributes: {}, ...overrides });
}
const report = (events: TelemetryEvent[]) => summarizeEvents(events, { invalid: 0, truncated: false });
function denied(seconds: number, overrides: Partial<TelemetryEvent> = {}) {
  return event({ occurred_at: at(seconds), event_name: "participation.checked", call_id: hash(`call:${seconds}`),
    trace_id: hash(`turn:${seconds}`), context: { version: 1, stage: "task", decision: "deny", task_state: "missing", native_tool: "patch" },
    attributes: { transport: "hook", event: "PreToolUse" }, ...overrides });
}

test("新调用按call_id精确关联：时间相隔和并发不串联，历史事件仍保守匹配", () => {
  const main = event({ call_id: hash("a"), attributes: { tool: "task_check", transport: "mcp" }, reason_code: "REVIEW_STALE" });
  const another = event({ ...main, event_id: randomUUID(), call_id: hash("b") });
  const derived = event({ ...main, event_id: randomUUID(), occurred_at: at(10), event_name: "quality.checked" });
  assert.equal(derivedToolEvents([main, another, derived]).get(derived), main);
  const noCall = [main, derived].map(({ call_id: _, ...entry }) => entry);
  assert.equal(derivedToolEvents(noCall).size, 0);
  noCall[1]!.occurred_at = at(0);
  assert.equal(derivedToolEvents(noCall).size, 1);
  assert.equal(derivedToolEvents([main, { ...main, event_id: randomUUID() }, derived]).size, 0);
  assert.equal(derivedToolEvents([main, derived, { ...derived, event_id: randomUUID() }]).size, 0);
});

test("同call也不得跨安装、会话、项目或工作目录消除信号", () => {
  const main = event({ call_id: hash("a"), attributes: { tool: "task_check", transport: "mcp" } });
  const derived = event({ ...main, event_id: randomUUID(), event_name: "quality.checked" });
  for (const changed of [{ install_id: randomUUID() }, { session_id: hash("other") }, { project_id: hash("other") }, { workdir_id: hash("other") }])
    assert.equal(derivedToolEvents([main, { ...derived, ...changed }]).size, 0);
});

test("同hook的准备拒绝与收尾只统计一次，独立身份拒绝和歧义保留", () => {
  const main = denied(0, { task_id: hash("task") });
  const ending = event({ ...main, event_id: randomUUID(), task_id: null, event_name: "hook.finished", reason_code: "WRITE_CHECK_COMPLETED" });
  const actual = report([main, ending]);
  assert.equal(actual.signal_coverage.raw_events, 2);
  assert.equal(actual.signal_coverage.primary_signals, 1);
  assert.equal(actual.incident_analysis.chains[0]?.event_count, 1);
  assert.equal(actual.traces[0]?.event_count, 2);
  const rejected = { ...ending, reason_code: "MCP_IDENTITY_REJECTED" };
  assert.equal(report([rejected]).signal_coverage.primary_signals, 1);
  assert.equal(report([main, rejected]).signal_coverage.primary_signals, 2);
  assert.equal(derivedToolEvents([main, { ...main, event_id: randomUUID() }, ending]).size, 0);
});

test("跨轮反复拒绝形成有界证据；成功推进打断观察，失败收尾不打断", () => {
  const values = [denied(0), denied(1), denied(2)];
  let signals = report(values).incident_analysis.signals;
  assert.equal(signals.length, 1); assert.equal(signals[0]?.kind, "repeated_guard");
  assert.equal(signals[0]?.occurrences, 3); assert.equal(signals[0]?.trace_keys.length, 3);
  assert.equal(signals[0]?.assessment, "needs_review");
  const ready = event({ occurred_at: at(3), outcome: "ok", reason_code: "WRITE_READY" });
  signals = report([...values, ready, denied(4)]).incident_analysis.signals;
  assert.equal(signals.length, 1); assert.equal(signals[0]?.progress_observed, true);
  const failed = { ...ready, outcome: "incomplete" as const };
  signals = report([denied(0), failed, denied(4)]).incident_analysis.signals;
  assert.equal(signals[0]?.progress_observed, false);
  assert.equal(report([denied(0), denied(301)]).incident_analysis.total_signals, 0);
});

test("调用链按install/session/project隔离，无会话身份不跨轮拼接", () => {
  for (const changed of [{ install_id: randomUUID() }, { session_id: hash("other") }, { project_id: hash("other") }]) {
    const actual = report([denied(0), denied(1, changed)]);
    assert.equal(actual.incident_analysis.total_chains, 2);
    assert.equal(actual.incident_analysis.total_signals, 0);
  }
  const actual = report([denied(0, { session_id: null }), denied(1, { session_id: null })]);
  assert.equal(actual.incident_analysis.total_chains, 2);
  assert.equal(actual.incident_analysis.total_signals, 0);
});

test("仅有workdir的读取记录不会伪装成项目或与实际Git绑定串联", () => {
  const workdir_id = hash("dir");
  const actual = report([denied(0, { project_id: null, workdir_id }), denied(1, { project_id: null, workdir_id }),
    denied(2, { project_id: project, workdir_id }), denied(3, { project_id: null, workdir_id: hash("different") })]);
  assert.equal(actual.incident_analysis.total_chains, 3);
  const workdir = actual.incident_analysis.chains.find(chain => chain.workdir_id === workdir_id)!;
  assert.equal(workdir.grouping, "workdir_only"); assert.equal(workdir.project_id, null);
  assert.equal(workdir.event_count, 2);
  assert.match(renderInsights(actual), /仅工作目录，项目未知/);
});

test("相同trace/task摘要不串联不同安装，缺project的轮次按workdir分开", () => {
  const task_id = hash("task");
  const first = event({ task_id });
  const second = event({ task_id, install_id: randomUUID() });
  const actual = report([first, second]);
  assert.equal(actual.total_traces, 2);
  assert.notEqual(actual.traces[0]?.trace_key, actual.traces[1]?.trace_key);
  assert.ok(actual.traces.every(value => value.related_trace_keys.length === 0));
  assert.equal(report([event({ project_id: null, workdir_id: hash("a") }), event({ project_id: null, workdir_id: hash("b") })]).total_traces, 2);
  const unknownProject = report([first, event({ task_id, trace_id: hash("unknown project"), project_id: null, workdir_id: project })]);
  assert.ok(unknownProject.traces.every(value => value.related_trace_keys.length === 0));
  const related = report([first, event({ task_id, trace_id: hash("second turn") })]);
  assert.ok(related.traces.every(value => value.related_trace_keys.length === 1));
});

const mergeOpen = () => event({ outcome: "error", reason_code: "UNMERGED_CHANGES", attributes: { tool: "task_open", transport: "mcp" } });
test("根据真实顺序识别疑似merge恢复循环；任务成功推进、隔离和过期不误报", () => {
  const restore = denied(1, { context: { version: 1, decision: "deny", command_family: "git_restore" } });
  const signal = report([mergeOpen(), restore]).incident_analysis.signals[0]!;
  assert.equal(signal.kind, "merge_recovery_cycle"); assert.equal(signal.assessment, "needs_review");
  assert.equal(signal.event_ids.length, 2);
  const opened = event({ occurred_at: at(0.5), outcome: "ok", reason_code: "TASK_OPENED", attributes: { tool: "task_open" } });
  assert.equal(report([mergeOpen(), opened, restore]).incident_analysis.total_signals, 0);
  assert.equal(report([mergeOpen(), { ...restore, occurred_at: at(301) }]).incident_analysis.total_signals, 0);
  assert.equal(report([restore, { ...mergeOpen(), occurred_at: at(2) }]).incident_analysis.total_signals, 0);
  assert.equal(report([mergeOpen(), { ...restore, project_id: hash("other") }]).incident_analysis.total_signals, 0);
  assert.equal(report([mergeOpen(), denied(1, { context: { version: 1, decision: "deny", command_family: "other" } })]).incident_analysis.total_signals, 0);
});

test("命令分类仅提示待复核，复杂动态语法不凭能力类别断言只读", () => {
  const direct = denied(0, { context: { version: 1, decision: "deny", command_class: "read_only", command_family: "search" } });
  const classifiedUnknown = denied(1, { context: { version: 1, decision: "deny", command_class: "unknown", command_family: "number_lines", command_shape: "pipeline" } });
  const dynamic = denied(2, { context: { version: 1, decision: "deny", command_class: "unknown", command_family: "search", command_shape: "dynamic" } });
  const actual = report([direct, classifiedUnknown, dynamic]);
  assert.equal(actual.incident_analysis.signals.filter(value => value.kind === "read_classification_review").length, 2);
  assert.match(renderInsights(actual), /待复核/);
});

test("接入线索保留旧配置/范围信息，只有观测到接入成功才标后续推进", () => {
  const pending = event({ reason_code: "PROJECT_SETUP_REQUIRED", context: { version: 1, scope_mode: "legacy", scope_state: "not_enrolled", required_action: "prepare" } });
  const prepared = event({ occurred_at: at(1), attributes: { tool: "project_prepare" }, outcome: "ok", reason_code: "OK", context: { version: 1, scope_mode: "projects", scope_state: "enrolled" } });
  const actual = report([pending, prepared]);
  assert.equal(actual.incident_analysis.signals[0]?.kind, "enrollment_pending");
  assert.equal(actual.incident_analysis.signals[0]?.progress_observed, true);
  const html = renderInsights(actual);
  assert.match(html, /接入模式：旧版配置/); assert.match(html, /范围状态：未接入/);
  assert.match(html, /后续推进，仍需核对结果/);
  assert.equal(report([pending, { ...prepared, project_id: hash("other") }]).incident_analysis.signals[0]?.progress_observed, false);
});

test("旧事件上下文明确未知，HTML只呈现已观测字段且转义内容", () => {
  assert.equal(contextDescription(undefined), "旧事件或未采集结构化上下文：未知");
  assert.match(contextDescription({ version: 1, conflict_count: 0 }), /当前冲突文件数：0/);
  const initialOnly = contextDescription({ version: 1, initial_conflict_count: 3 });
  assert.match(initialOnly, /恢复任务创建时冲突文件数：3/); assert.ok(!initialOnly.includes("当前冲突文件数"));
  assert.match(contextDescription({ version: 1 }), /判断阶段：未观测；判断结果：未观测/);
  const actual = report([event()]);
  actual.issues[0]!.key = "<script>unsafe</script>";
  const html = renderInsights(actual);
  assert.match(html, /旧事件或未采集结构化上下文：未知/);
  assert.ok(!html.includes("<script>unsafe")); assert.ok(html.includes("&lt;script&gt;"));
  assert.match(html, /不代表确定缺陷/);
});

test("大样本展示收敛并明确截断，重复证据仍累计真实观测次数", () => {
  const repeated = Array.from({ length: 1000 }, (_, index) => denied(index / 10));
  const actual = report(repeated);
  assert.equal(actual.incident_analysis.signals[0]?.occurrences, 1000);
  assert.equal(actual.incident_analysis.signals[0]?.event_ids.length, 20);
  assert.equal(actual.incident_analysis.chains[0]?.events.length, 20);
  assert.equal(actual.incident_analysis.chains[0]?.event_count, 1000);
  assert.equal(actual.traces.length, 200); assert.equal(actual.traces_truncated, true);
  const oneTrace = report(repeated.map(value => ({ ...value, trace_id: trace })));
  assert.equal(oneTrace.traces[0]?.event_count, 1000);
  assert.equal(oneTrace.traces[0]?.events.length, 100);
  assert.equal(oneTrace.traces[0]?.events_truncated, true);
  const manyChains = report(Array.from({ length: 201 }, (_, index) => denied(index, { project_id: hash(`project:${index}`),
    reason_code: "PROJECT_NOT_ENROLLED", context: { version: 1, scope_mode: "projects", scope_state: "not_enrolled" } })));
  assert.equal(manyChains.incident_analysis.chains.length, 200);
  assert.equal(manyChains.incident_analysis.total_chains, 201);
  assert.equal(manyChains.incident_analysis.signals.length, 200);
  assert.equal(manyChains.incident_analysis.signals_truncated, true);
  assert.match(renderInsights(manyChains), /展示 200 条（截断）/);
  const manyIssues = report(Array.from({ length: 201 }, (_, index) => event({ reason_code: `FAILURE_${index}` })));
  assert.equal(manyIssues.total_issue_clusters, 201); assert.equal(manyIssues.issues.length, 200);
  assert.equal(manyIssues.issue_clusters_truncated, true);
});
