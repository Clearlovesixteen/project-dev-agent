import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { DiagnosticEvent, LegacyDiagnosticEvent, type TelemetryEvent } from "../src/observability/contracts.js";
import { DiagnosticBatch, assertAcknowledgementV2, legacyDiagnosticProjection } from "../src/observability/batch.js";
import { RuntimeSettings, DIAGNOSTIC_NOTICE, runtimeFiles } from "../src/runtime/config.js";
import { DiagnosticWriter, EVENT_DIRECTORY } from "../src/observability/writer.js";
import { uploadDiagnostics } from "../src/observability/uploader.js";
import { UPLOAD_RECEIPTS, pruneUploadReceipts, saveUploadReceipt } from "../src/observability/upload-receipts.js";
import { acquireFileLock } from "../src/storage/file-lock.js";
import { PUBLISHED_DIAGNOSTICS } from "../src/runtime/published-diagnostics.js";
import worker from "../tools/diagnostics-collector/worker.js";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const token = "isolated-diagnostic-profile-token";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function example(): TelemetryEvent {
  return DiagnosticEvent.parse({ schema_version: 1, event_id: randomUUID(), occurred_at: new Date().toISOString(), upload_epoch: randomUUID(),
    event_name: "participation.checked", install_id: randomUUID(), trace_id: "a".repeat(64), project_id: null, session_id: null, task_id: null,
    runtime_version: "0.13.6-fix.1", policy_version: 1, mode: "auto", outcome: "incomplete", reason_code: "TASK_BINDING_REQUIRED", duration_ms: 12,
    evidence_level: "observed", attributes: { transport: "hook" }, call_id: "b".repeat(64), operation_id: "c".repeat(64), workdir_id: "d".repeat(64),
    context: { version: 1, stage: "task", task_state: "missing", command_family: "number_lines", required_action: "open_task" } });
}
function collector() {
  const stored = new Map<string, unknown>(); let fail = false;
  const env = { WRITE_TOKEN: token, DIAGNOSTICS_DB: {
    prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ values, run: async () => ({}) }) }),
    batch: async (rows: { values: unknown[] }[]) => { if (fail) throw new Error("private-database-message");
      for (const { values } of rows) stored.set(`${values[0]}:${values[1]}`, JSON.parse(values[7] as string)); return []; },
  } };
  const send = (events: unknown[], v2 = true, batchId = hash(events)) => worker.fetch(new Request(`https://collector.example/events${v2 ? "/v2" : ""}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: v2 ? 2 : 1, batch_id: batchId, ...(v2 ? { install_id: (events[0] as TelemetryEvent).install_id } : {}), events }),
  }), env as never);
  return { stored, send, env, fail: () => { fail = true; } };
}
type Wire = { schema_version: number; batch_id: string; install_id?: string; events: TelemetryEvent[] };
const legacyAck = (response: ServerResponse, batch: Wire) => response.end(JSON.stringify({ batch_id: batch.batch_id, acknowledged: batch.events.length }));
const v2Ack = (response: ServerResponse, batch: Wire, reject = -1) => response.end(JSON.stringify({ schema_version: 2, batch_id: batch.batch_id,
  accepted_indexes: batch.events.flatMap((_event, index) => index === reject ? [] : [index]), rejected: reject < 0 ? [] : [{ index: reject, reason: "EVENT_SCHEMA" }] }));
async function receiver(t: test.TestContext, handle: (path: string, batch: Wire, response: ServerResponse, call: number) => unknown) {
  const home = await mkdtemp(join(tmpdir(), "pda-profile-")); t.after(() => rm(home, { recursive: true, force: true }));
  const calls: { path: string; batch: Wire }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const batch = JSON.parse(Buffer.concat(chunks).toString()) as Wire, path = request.url!; calls.push({ path, batch });
    try { await handle(path, batch, response, calls.length); } catch { response.statusCode = 500; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const settings = new RuntimeSettings(home), writer = new DiagnosticWriter(home);
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { local: true, upload: true, notice_version: DIAGNOSTIC_NOTICE,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/events`, write_token: token } });
  const config = await settings.current(), day = new Date().toISOString().slice(0, 10), eventFile = join(home, EVENT_DIRECTORY, `${day}.jsonl`);
  await mkdir(join(home, EVENT_DIRECTORY), { recursive: true });
  const event = { ...example(), upload_epoch: config.diagnostics.upload_epoch! }, events = (count: number) => Array.from({ length: count }, () => ({ ...event, event_id: randomUUID() }));
  const set = async (values: unknown[]) => writeFile(eventFile, values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n") + "\n");
  const cursor = async () => JSON.parse(await readFile(join(home, "project-dev-agent/telemetry/upload.json"), "utf8"));
  const receipts = async () => JSON.parse(await readFile(join(home, UPLOAD_RECEIPTS), "utf8"));
  return { home, calls, writer, settings, event, events, set, cursor, receipts, eventFile };
}

test("v1白名单投影精确剔除四个扩展字段，旧客户端对新Worker的协议保持原样", async () => {
  const event = example(), projected = legacyDiagnosticProjection(event), s = collector();
  assert.equal(LegacyDiagnosticEvent.safeParse(event).success, false);
  assert.deepEqual(Object.keys(event).filter(key => !(key in projected)).sort(), ["call_id", "context", "operation_id", "workdir_id"]);
  const old = await s.send([projected], false); assert.equal(old.status, 200);
  assert.deepEqual(await old.json(), { batch_id: hash([projected]), acknowledged: 1 });
  assert.equal((await s.send([event], false)).status, 400, "不能在v1入口偷偷扩展旧白名单");
  assert.equal((await s.send([projected], false)).status, 200); assert.equal(s.stored.size, 1);
});

test("v2单项坏数据不堵好事件，完整确认且不回显正文；DB失败和摘要错误不假确认", async () => {
  const event = example(), s = collector(), events = [event,
    { ...event, event_id: randomUUID(), raw_prompt: "private-prompt-never-store" },
    { ...event, event_id: randomUUID(), occurred_at: "2100-01-01T00:00:00.000Z" },
    { ...event, event_id: randomUUID(), install_id: randomUUID() },
    { ...event, event_id: randomUUID(), upload_epoch: null },
    { ...event, event_id: randomUUID(), context: { version: 1, raw: "x".repeat(5000) } },
  ];
  const response = await s.send(events); assert.equal(response.status, 200);
  const ack = await response.json() as any;
  assert.deepEqual(ack.accepted_indexes, [0]);
  assert.deepEqual(ack.rejected.map((item: any) => item.reason), ["EVENT_SCHEMA", "EVENT_TIME_RANGE", "EVENT_INSTALL_MISMATCH", "EVENT_UPLOAD_DISABLED", "EVENT_TOO_LARGE"]);
  assertAcknowledgementV2(ack, hash(events), events.length); assert.equal(s.stored.size, 1);
  assert.ok(!JSON.stringify([...s.stored.values()]).includes("private-prompt")); assert.ok(!JSON.stringify(ack).includes("private-prompt"));
  assert.equal((await s.send(events)).status, 200); assert.equal(s.stored.size, 1);
  assert.equal((await s.send(events, true, "0".repeat(64))).status, 400);
  s.fail(); const failed = await s.send(events); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { code: "COLLECTOR_UNAVAILABLE" });
});

test("v2回执须与原批完整互斥对应，缺项重复越界和错误hash均拒绝", () => {
  const batchId = "a".repeat(64), valid = { schema_version: 2 as const, batch_id: batchId, accepted_indexes: [0], rejected: [{ index: 1, reason: "EVENT_SCHEMA" as const }] };
  assert.doesNotThrow(() => assertAcknowledgementV2(valid, batchId, 2));
  for (const ack of [{ ...valid, accepted_indexes: [0, 1] }, { ...valid, rejected: [] }, { ...valid, accepted_indexes: [2] }, { ...valid, batch_id: "b".repeat(64) }])
    assert.throws(() => assertAcknowledgementV2(ack, batchId, 2), /UPLOAD_ACK_MISMATCH/);
});

test("公开v2入口保持鉴权和三层限流，逐项拒绝也不能绕过入库前检查", async () => {
  const events = [example()], batch = { schema_version: 2, batch_id: hash(events), install_id: events[0]!.install_id, events };
  const s = collector(), keys: string[] = []; let blocked = "";
  const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !blocked || !key.startsWith(blocked) }; } };
  const env = { ...s.env, PUBLIC_SOURCE_LIMIT: limiter, PUBLIC_TOTAL_LIMIT: limiter };
  const send = (path = "/public/events/v2", requestToken: string = PUBLISHED_DIAGNOSTICS.ingest_key) => worker.fetch(new Request(`https://collector.example${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${requestToken}`, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.19" }, body: JSON.stringify(batch),
  }), env as never);
  assert.equal((await send("/events/v2")).status, 401); assert.equal((await send(undefined, "invalid-public-key")).status, 401);
  for (const prefix of ["source:", "install:", "public-diagnostics"]) {
    blocked = prefix; const response = await send(); assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(s.stored.size, 0); assert.ok(keys.some(key => key.startsWith(prefix)));
  }
  blocked = ""; const response = await send(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as any).accepted_indexes, [0]); assert.equal(s.stored.size, 1);
  assert.ok(!JSON.stringify([...s.stored.values()]).includes("192.0.2.19"));
});

test("真实上传v2页的拒绝摘要先保存，再推进后续页且保留本地完整事件", async t => {
  const s = await receiver(t, (_path, batch, response, call) => v2Ack(response, batch, call === 1 ? 0 : -1));
  const events = s.events(55); await s.set(events);
  const result = await uploadDiagnostics(s.home); assert.equal(result.state, "partial"); assert.equal(result.sent, 54); assert.equal(result.rejected, 1);
  assert.deepEqual(s.calls.map(call => [call.path, call.batch.events.length]), [["/events/v2", 50], ["/events/v2", 5]]);
  const ledger = await s.receipts(); assert.equal(ledger.records.length, 1); assert.deepEqual(ledger.records[0].rejected, [{ index: 0, reason: "EVENT_SCHEMA" }]);
  assert.ok(Object.values((await s.cursor()).positions).includes(55)); assert.ok((await readFile(s.eventFile, "utf8")).includes('"command_family":"number_lines"'));
  assert.ok(!JSON.stringify(ledger).includes('"context"')); assert.ok(!JSON.stringify(ledger).includes(token));
});

test("旧worker仅404/405时同预算降级一次，严格v1投影且明确记录上下文未上传", async t => {
  for (const status of [404, 405]) await t.test(String(status), async t => {
    const s = await receiver(t, (path, batch, response) => {
      if (path.endsWith("/v2")) { response.statusCode = status; response.end(); return; }
      DiagnosticBatch.parse(batch); legacyAck(response, batch);
    });
    await s.set(s.events(101)); const result = await uploadDiagnostics(s.home);
    assert.equal(result.state, "partial"); assert.equal(result.sent, 101); assert.equal(result.omitted, 101);
    assert.deepEqual(s.calls.map(call => call.path), ["/events/v2", "/events", "/events", "/events"]);
    assert.ok(s.calls.slice(1).every(call => call.batch.events.every(event => LegacyDiagnosticEvent.safeParse(event).success)));
    const ledger = await s.receipts(); assert.equal(ledger.records.reduce((sum: number, item: any) => sum + item.omitted_detail_count, 0), 101);
    // 摘要是游标推进前的同步事实；附加gap只占50ms预算，允许后台写入稍后收尾。
    const deadline = performance.now() + 1000; let gap = false;
    do {
      gap = (await s.writer.read()).events.some(event => event.reason_code === "UPLOAD_V1_CONTEXT_OMITTED");
      if (!gap) await new Promise(resolve => setTimeout(resolve, 10));
    } while (!gap && performance.now() < deadline);
    assert.ok(gap);
  });
});

test("400/认证/限流/5xx不会降级或推进，错误正文不进入诊断", async t => {
  for (const status of [400, 401, 403, 429, 500]) await t.test(String(status), async t => {
    const s = await receiver(t, (_path, _batch, response) => { response.statusCode = status; response.end("private-server-error-text"); });
    await s.set(s.events(2)); assert.equal((await uploadDiagnostics(s.home)).state, "unavailable");
    assert.equal(s.calls.length, 1); assert.deepEqual((await s.cursor()).positions, {});
    assert.equal((await uploadDiagnostics(s.home)).state, "backoff");
    assert.ok(!JSON.stringify((await s.writer.read()).events).includes("private-server-error-text"));
  });
});

test("错误逐项确认或拒绝证据保存失败，均不能推进已上传页游标", async t => {
  const bad = await receiver(t, (_path, batch, response) => response.end(JSON.stringify({ schema_version: 2, batch_id: batch.batch_id, accepted_indexes: [0, 0], rejected: [] })));
  await bad.set(bad.events(2)); assert.equal((await uploadDiagnostics(bad.home)).state, "unavailable"); assert.deepEqual((await bad.cursor()).positions, {});
  const blocked = await receiver(t, (_path, batch, response) => v2Ack(response, batch, 0));
  await blocked.set(blocked.events(2)); await mkdir(join(blocked.home, UPLOAD_RECEIPTS));
  assert.equal((await uploadDiagnostics(blocked.home)).state, "unavailable"); assert.deepEqual((await blocked.cursor()).positions, {});
});

test("本地坏行和越时事件不堵队列，混合安装按页分开且只留位置摘要", async t => {
  const s = await receiver(t, (_path, batch, response) => { DiagnosticBatch.parse(batch); legacyAck(response, batch); });
  const a = legacyDiagnosticProjection(s.event), b = { ...a, event_id: randomUUID(), install_id: randomUUID() };
  await s.set(["{private-invalid-body", { ...a, occurred_at: "2100-01-01T00:00:00.000Z" }, a, b]);
  const result = await uploadDiagnostics(s.home); assert.equal(result.sent, 2); assert.equal(result.invalid, 2); assert.equal(result.state, "partial");
  assert.deepEqual(s.calls.map(call => call.batch.events.length), [1, 1]);
  const ledger = await s.receipts(); assert.equal(ledger.records[0].local_rejections.length, 2);
  assert.ok(!JSON.stringify(ledger).includes("private-invalid-body")); assert.ok(Object.values((await s.cursor()).positions).includes(4));
});

test("v2不可用期间关闭上报阻止v1重发，换周期也不补传旧详情", async t => {
  let settings: RuntimeSettings;
  const s = await receiver(t, async (_path, _batch, response) => {
    const current = await settings.current(); await settings.configure({ apply: true, expected_revision: current.revision, diagnostics: { upload: false } });
    response.statusCode = 404; response.end();
  }); settings = s.settings;
  await s.set(s.events(2)); assert.equal((await uploadDiagnostics(s.home)).state, "configuration_changed"); assert.equal(s.calls.length, 1);
  assert.equal((await uploadDiagnostics(s.home)).state, "disabled");
  const current = await settings.current(); await settings.configure({ apply: true, expected_revision: current.revision, diagnostics: { upload: true } });
  assert.equal((await uploadDiagnostics(s.home)).sent, 0); assert.equal(s.calls.length, 1);
});

test("v2探测和v1降级共用原发送预算，第二请求挂起不重新获得完整期限", async t => {
  const s = await receiver(t, async (path, _batch, response) => {
    if (path.endsWith("/v2")) { await new Promise(resolve => setTimeout(resolve, 120)); response.statusCode = 404; response.end(); }
  });
  await s.set(s.events(1)); const started = performance.now(), result = await uploadDiagnostics(s.home, 350);
  assert.equal(result.state, "unavailable"); assert.equal(s.calls.length, 2); assert.ok(performance.now() - started < 1400);
  assert.deepEqual((await s.cursor()).positions, {});
});

test("拒绝摘要有界且30天过期清理不覆盖正在上传的数据", async t => {
  const home = await mkdtemp(join(tmpdir(), "pda-receipt-")); t.after(() => rm(home, { recursive: true, force: true }));
  const files = await runtimeFiles(home); await files.directory("project-dev-agent/telemetry");
  const base = { batch_id: "a".repeat(64), epoch: randomUUID(), at: new Date().toISOString(), accepted_count: 0,
    omitted_detail_count: 0, rejected: [{ index: 0, reason: "EVENT_SCHEMA" as const }], local_rejections: [] };
  await saveUploadReceipt(files, base);
  await saveUploadReceipt(files, { ...base, at: new Date(Date.now() + 1000).toISOString() });
  assert.equal(JSON.parse(await files.read(UPLOAD_RECEIPTS)).records.length, 1, "相同回执重试不重复留存");
  for (let index = 0; index < 104; index++) await saveUploadReceipt(files, { ...base, batch_id: hash(index) });
  let ledger = JSON.parse(await files.read(UPLOAD_RECEIPTS)); assert.equal(ledger.records.length, 100); assert.equal(ledger.truncated, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(ledger)) <= 60_000);
  ledger.records[0].at = new Date(Date.now() - 31 * 86_400_000).toISOString();
  await writeFile(join(home, UPLOAD_RECEIPTS), JSON.stringify(ledger));
  const release = await acquireFileLock(files, "project-dev-agent/telemetry/upload.lock", "UPLOAD_BUSY");
  try { await pruneUploadReceipts(files); assert.equal(JSON.parse(await files.read(UPLOAD_RECEIPTS)).records.length, 100); }
  finally { await release(); }
  await pruneUploadReceipts(files); ledger = JSON.parse(await files.read(UPLOAD_RECEIPTS));
  assert.equal(ledger.records.length, 99); assert.equal(ledger.truncated, 5);
  assert.ok(ledger.records.every((item: { at: string }) => Date.parse(item.at) >= Date.now() - 30 * 86_400_000));
});
