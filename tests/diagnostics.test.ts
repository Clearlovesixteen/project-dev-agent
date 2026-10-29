import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { DiagnosticWriter, observeTool } from "../src/observability/writer.js";
import { DIAGNOSTIC_NOTICE, RuntimeSettings } from "../src/runtime/config.js";
import { uploadDiagnostics } from "../src/observability/uploader.js";

async function home(t: test.TestContext) { const path = await mkdtemp(join(tmpdir(), "pda-diagnostics-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test("诊断设置单独保存，缺少告知或接收端时拒绝远程上报，状态不返回凭证", async (t) => {
  const root = await home(t), settings = new RuntimeSettings(root);
  assert.equal((await settings.status()).mode, "manual");
  await assert.rejects(settings.configure({ apply: true, expected_revision: null, diagnostics: { upload: true } }), { code: "DIAGNOSTICS_SETUP_REQUIRED" });
  await settings.configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: {
    upload: true, notice_version: DIAGNOSTIC_NOTICE, endpoint: "https://example.test/events", write_token: "a-private-write-token" } });
  assert.ok(!JSON.stringify(await settings.status()).includes("a-private-write-token"));
  assert.ok((await settings.current()).diagnostics.enabled_at);
  await assert.rejects(settings.configure({ apply: true, expected_revision: null, mode: "manual" }), { code: "RUNTIME_CHANGED" });
  await assert.rejects(readFile(join(root, "project-dev-agent/settings.json")), { code: "ENOENT" });
});

test("白名单事件拒绝原始输入，路径和身份去标识；并发追加不会覆盖其他事件", async (t) => {
  const root = await home(t), writer = new DiagnosticWriter(root), secret = "a-user-prd-and-private-path";
  await Promise.all(Array.from({ length: 40 }, (_, index) => writer.record("context.lookup", { project: secret, session: secret, trace: `trace-${index}`, attributes: { selected_count: index } })));
  const result = await writer.read();
  assert.equal(result.events.length, 40); assert.equal(result.invalid, 0);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(await writer.record("context.lookup", { attributes: { raw_prompt: secret } as never }), false);
  assert.equal((await writer.read()).events.length, 40);
});

test("结构化工具错误被记录，采集文件不可写时仍保留原工具结果", async (t) => {
  const root = await home(t), writer = new DiagnosticWriter(root);
  const result = await observeTool(writer, "project_context", "/private/project", async () => ({ outcome: "error", code: "EXPECTED_FAILURE" }));
  assert.equal(result.code, "EXPECTED_FAILURE");
  assert.equal((await writer.read()).events[0]?.outcome, "error");
  const settings = new RuntimeSettings(root), config = await settings.current();
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { local: false } });
  assert.equal(await writer.record("hook.received"), false);
  assert.equal((await observeTool(writer, "project_context", undefined, async () => ({ outcome: "ok", code: "PRESERVED" }))).code, "PRESERVED");
  assert.equal(config.mode, "manual");
});

test("符号链接与损坏的运行配置不触发越界写入或覆盖", async (t) => {
  const root = await home(t), outside = await home(t);
  await symlink(outside, join(root, "project-dev-agent"));
  assert.equal(await new DiagnosticWriter(root).record("hook.received"), false);
  await assert.rejects(readFile(join(outside, "telemetry/identity.json")), { code: "ENOENT" });
  await rm(join(root, "project-dev-agent")); await mkdir(join(root, "project-dev-agent"));
  await writeFile(join(root, "project-dev-agent/runtime.json"), "corrupt");
  await assert.rejects(new RuntimeSettings(root).configure({ apply: true, expected_revision: null }), { code: "RUNTIME_CONFIG_INVALID" });
  assert.equal(await readFile(join(root, "project-dev-agent/runtime.json"), "utf8"), "corrupt");
});

test("后台发送必须先启用，接收端确认后前移游标，关闭和重新启用不上传先前本地内容", async (t) => {
  const root = await home(t), writer = new DiagnosticWriter(root), settings = new RuntimeSettings(root);
  let requests = 0, received = 0;
  const server = createServer(async (request, response) => {
    requests++; assert.equal(request.headers.authorization, "Bearer a-private-write-token");
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); received += body.events.length;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ batch_id: body.batch_id, acknowledged: body.events.length }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  await writer.record("hook.received");
  assert.equal((await uploadDiagnostics(root)).state, "disabled"); assert.equal(requests, 0);
  await settings.configure({ apply: true, expected_revision: null, diagnostics: {
    upload: true, notice_version: DIAGNOSTIC_NOTICE, endpoint: `http://127.0.0.1:${address.port}/events`, write_token: "a-private-write-token" } });
  await writer.record("context.lookup", { attributes: { selected_count: 1 } });
  assert.equal((await uploadDiagnostics(root)).sent, 1); assert.equal(received, 1);
  assert.equal((await uploadDiagnostics(root)).sent, 0); assert.equal(requests, 1);
  const config = await settings.current();
  await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { upload: false } });
  await writer.record("context.lookup");
  assert.equal((await uploadDiagnostics(root)).state, "disabled"); assert.equal(requests, 1);
});

test("错误确认不推进队列并进入退避；关闭后重新启用只发送新周期事件", async t => {
  const root = await home(t), settings = new RuntimeSettings(root), writer = new DiagnosticWriter(root);
  let requests = 0, accepted: unknown[] = [], correct = false;
  const server = createServer(async (request, response) => {
    requests++; const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const batch = JSON.parse(Buffer.concat(chunks).toString());
    if (correct) accepted = batch.events;
    response.end(JSON.stringify({ batch_id: correct ? batch.batch_id : "wrong", acknowledged: batch.events.length }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/events`;
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { upload: true, notice_version: DIAGNOSTIC_NOTICE, endpoint, write_token: "a-private-write-token" } });
  await writer.record("hook.received");
  assert.equal((await uploadDiagnostics(root)).state, "unavailable"); assert.equal(requests, 1);
  assert.equal((await uploadDiagnostics(root)).state, "backoff"); assert.equal(requests, 1);
  let config = await settings.current();
  await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { upload: false } });
  await writer.record("context.lookup", { reason: "DURING_DISABLED" });
  config = await settings.current();
  await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { upload: true } });
  assert.notEqual((await settings.current()).diagnostics.upload_epoch, config.diagnostics.upload_epoch);
  await writer.record("context.emitted", { reason: "NEW_EPOCH" }); correct = true;
  assert.equal((await uploadDiagnostics(root)).sent, 1); assert.equal(accepted.length, 1);
  assert.equal((accepted[0] as { reason_code: string }).reason_code, "NEW_EPOCH");
});
