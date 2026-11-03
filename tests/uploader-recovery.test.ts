import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { RuntimeSettings, DIAGNOSTIC_NOTICE } from "../src/runtime/config.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import type { TelemetryEvent } from "../src/observability/contracts.js";
import { uploadDiagnostics } from "../src/observability/uploader.js";

type Batch = { batch_id: string; events: TelemetryEvent[] };
const acknowledge = (response: ServerResponse, batch: Batch) => response.end(JSON.stringify({ batch_id: batch.batch_id, acknowledged: batch.events.length }));

/** 所有收件、配置修改与重试均在独立用户目录和回环服务中，不触碰真实上报周期。 */
async function receiver(t: test.TestContext, handle: (batch: Batch, response: ServerResponse, request: number) => Promise<void> | void) {
  const home = await mkdtemp(join(tmpdir(), "pda-upload-recovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: Batch[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const batch = JSON.parse(Buffer.concat(chunks).toString()) as Batch;
    calls.push(batch); await handle(batch, response, calls.length);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const settings = new RuntimeSettings(home), writer = new DiagnosticWriter(home);
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { upload: true, notice_version: DIAGNOSTIC_NOTICE,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/events`, write_token: "isolated-upload-recovery-token" } });
  const cursor = join(home, "project-dev-agent/telemetry/upload.json");
  const record = async (count: number) => {
    for (let index = 0; index < count; index++) assert.equal(await writer.record("health.checked"), true);
  };
  return { home, writer, settings, calls, cursor, record };
}

test("第二批确认失败后保留第一批游标，重试不重传已经确认的数据", async t => {
  let correct = false;
  const fixture = await receiver(t, (batch, response, request) => {
    if (!correct && request === 2) response.end(JSON.stringify({ batch_id: "wrong", acknowledged: batch.events.length }));
    else acknowledge(response, batch);
  });
  await fixture.record(121);
  const first = await uploadDiagnostics(fixture.home);
  assert.equal(first.state, "unavailable"); assert.equal(first.sent, 50);
  const stored = JSON.parse(await readFile(fixture.cursor, "utf8"));
  assert.ok(Object.values(stored.positions).includes(50));
  assert.equal(stored.failures, 1);
  assert.equal((await uploadDiagnostics(fixture.home)).state, "backoff");
  assert.equal(fixture.calls.length, 2);
  correct = true;
  // 测试不等待真实退避时间，只提前隔离目录中的下次重试时刻，保留已确认位置。
  await writeFile(fixture.cursor, JSON.stringify({ ...stored, next_attempt: 0 }));
  const retried = await uploadDiagnostics(fixture.home);
  assert.equal(retried.state, "ok"); assert.equal(retried.sent, 72); // 71 条原始事件与一条确认失败诊断。
  const confirmed = new Set(fixture.calls[0]!.events.map(event => event.event_id));
  assert.ok(fixture.calls.slice(2).every(batch => batch.events.every(event => !confirmed.has(event.event_id))));
  assert.equal(JSON.parse(await readFile(fixture.cursor, "utf8")).failures, 0);
});

test("多批发送共用总时间预算，后批超时不影响前批进度或无限延长收尾", async t => {
  const fixture = await receiver(t, (batch, response, request) => {
    if (request === 1) acknowledge(response, batch);
    // 第二批故意不返回确认，模拟真实接收端超时。
  });
  await fixture.record(101);
  const started = performance.now(), result = await uploadDiagnostics(fixture.home, 500);
  assert.equal(result.state, "unavailable"); assert.equal(result.sent, 50);
  assert.ok(performance.now() - started < 1800, "两批不得各自占用一份完整预算");
  assert.equal(fixture.calls.length, 2);
  assert.ok(Object.values(JSON.parse(await readFile(fixture.cursor, "utf8")).positions).includes(50));
  assert.ok((await fixture.writer.read()).events.some(event => event.reason_code === "UPLOAD_TIMEOUT"));
});

test("第一批发送期间关闭上报后，不再启动下一批并保留关闭配置", async t => {
  let settings: RuntimeSettings;
  const fixture = await receiver(t, async (batch, response) => {
    const config = await settings.current();
    await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { upload: false } });
    acknowledge(response, batch);
  });
  settings = fixture.settings;
  await fixture.record(101);
  const result = await uploadDiagnostics(fixture.home);
  assert.equal(result.state, "configuration_changed"); assert.equal(result.sent, 50);
  assert.equal(fixture.calls.length, 1);
  assert.equal((await settings.current()).diagnostics.upload, false);
  assert.equal((await uploadDiagnostics(fixture.home)).state, "disabled");
});

test("积压超过四批时有界暂停，下次从已确认位置继续", async t => {
  const fixture = await receiver(t, (batch, response) => { acknowledge(response, batch); });
  await fixture.record(251);
  const first = await uploadDiagnostics(fixture.home);
  assert.equal(first.state, "pending"); assert.equal(first.sent, 200);
  assert.deepEqual(fixture.calls.map(batch => batch.events.length), [50, 50, 50, 50]);
  const next = await uploadDiagnostics(fixture.home);
  assert.equal(next.state, "ok"); assert.equal(next.sent, 51);
  assert.equal(new Set(fixture.calls.flatMap(batch => batch.events.map(event => event.event_id))).size, 251);
});
