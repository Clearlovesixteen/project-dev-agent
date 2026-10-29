import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import worker from "../tools/diagnostics-collector/worker.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { RuntimeSettings, DIAGNOSTIC_NOTICE } from "../src/runtime/config.js";
import { developerInsights, renderInsights, summarizeEvents } from "../src/observability/insights.js";

// Node 18 的测试进程与 Workers 都使用标准 WebCrypto，不引入接收端额外依赖。
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
async function setup(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pda-collector-")); t.after(() => rm(home, { recursive: true, force: true }));
  const writer = new DiagnosticWriter(home);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, diagnostics: { upload: true,
    notice_version: DIAGNOSTIC_NOTICE, endpoint: "https://collector.example/events", write_token: "a-private-write-token" } });
  await writer.record("hook.received", { trace: "trace-one" });
  await writer.record("hook.finished", { trace: "trace-one", outcome: "degraded", reason: "HOOK_DEADLINE", duration: 1800 });
  const events = (await writer.read()).events;
  const batch = { schema_version: 1, batch_id: createHash("sha256").update(JSON.stringify(events)).digest("hex"), events };
  const stored = new Map<string, unknown>(); let fail = false;
  const db = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ values, run: async () => ({}) }), run: async () => ({}) }),
    batch: async (statements: unknown[]) => { if (fail) throw new Error("db offline"); for (const statement of statements as { values: unknown[] }[]) {
      stored.set(`${statement.values[0]}:${statement.values[1]}`, statement.values[7]); } return []; } };
  const env = { DIAGNOSTICS_DB: db as never, WRITE_TOKEN: "a-private-write-token" };
  const send = (body: unknown = batch, authorization = "Bearer a-private-write-token") => worker.fetch(new Request("https://collector.example/events", {
    method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  return { writer, home, events, batch, stored, send, fail: () => { fail = true; } };
}

test("接收端授权、白名单、批次摘要与持久确认，重复提交不增加事件", async t => {
  const { batch, send, stored, fail } = await setup(t);
  assert.equal((await send(batch, "Bearer not-authorized")).status, 401);
  assert.equal((await send({ ...batch, raw_prompt: "private" })).status, 400);
  assert.equal((await send({ ...batch, batch_id: "a".repeat(64) })).status, 400);
  assert.equal((await send({ ...batch, events: batch.events.map(event => ({ ...event, raw_path: "/private" })) })).status, 400);
  const first = await send(); assert.equal(first.status, 200); assert.equal((await first.json() as { acknowledged: number }).acknowledged, 2);
  assert.equal((await send()).status, 200); assert.equal(stored.size, 2);
  fail(); assert.equal((await send()).status, 503);
});

test("开发者诊断用实际元数据聚类和关联，不将回执或空样本误算成开发效果", async t => {
  const { home, events } = await setup(t);
  const report = await developerInsights({ home });
  assert.equal(report.counts.hooks_received, 1); assert.equal(report.counts.hooks_finished, 1);
  assert.equal(report.hook_duration_ms.p95, 1800); assert.ok(report.issues[0]?.key.includes("HOOK_DEADLINE"));
  assert.equal(report.traces.length, 1); assert.equal(report.counts.matched_receipts, 0);
  assert.equal((await developerInsights({ home, trace: events[0]!.trace_id })).sample_events, 2);
  const empty = summarizeEvents([], { invalid: 3, truncated: true });
  assert.equal(empty.hook_duration_ms.p95, null); assert.equal(empty.sample_events, 0); assert.equal(empty.coverage.invalid, 3);
  const html = renderInsights({ ...report, issues: [{ ...report.issues[0]!, key: "<script>alert('x')</script>" }] });
  assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;script&gt;")); assert.ok(html.includes("default-src 'none'"));
  assert.ok(!html.includes("a-private-write-token")); assert.ok(!html.includes(home));
});
