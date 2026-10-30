import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { diagnosticProxy, sendDiagnosticBatch } from "../src/observability/transport.js";

const system = "  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7897\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7898\n";
const signal = () => AbortSignal.timeout(3000);

test("诊断请求使用环境代理优先、macOS 系统代理补充，显式空值保持直连", async () => {
  const options = { env: {}, platform: "darwin" as const, readSystem: async () => system };
  assert.equal(await diagnosticProxy("https://collector.test/events", signal(), options), "http://127.0.0.1:7898/");
  assert.equal(await diagnosticProxy("http://collector.test/events", signal(), options), "http://127.0.0.1:7897/");
  assert.equal(await diagnosticProxy("https://collector.test/events", signal(), { ...options,
    env: { https_proxy: "http://127.0.0.1:9000", HTTPS_PROXY: "http://127.0.0.1:9001" } }), "http://127.0.0.1:9000/");
  assert.equal(await diagnosticProxy("https://collector.test/events", signal(), { ...options, env: { HTTPS_PROXY: "" } }), null);
  assert.equal(await diagnosticProxy("https://collector.test/events", signal(), { ...options, platform: "linux" }), null);
});

test("回环与 NO_PROXY 不经过代理，端口及域名后缀匹配不会扩大范围", async () => {
  const options = { env: { HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: ".example.test:443,exact.test" }, platform: "darwin" as const,
    readSystem: async () => { throw new Error("不应查询系统代理"); } };
  for (const endpoint of ["http://localhost:8000/events", "http://127.0.0.2:8000/events", "http://[::1]:8000/events",
    "https://sub.example.test/events", "https://example.test/events", "https://exact.test/events"])
    assert.equal(await diagnosticProxy(endpoint, signal(), options), null, endpoint);
  for (const endpoint of ["https://example.test:8443/events", "https://badexample.test/events", "https://sub.exact.test/events"])
    assert.equal(await diagnosticProxy(endpoint, signal(), options), "http://127.0.0.1:7897/", endpoint);
  assert.equal(await diagnosticProxy("https://any.test/events", signal(), { ...options, env: { NO_PROXY: "*" } }), null);
});

test("系统代理查询失败可直连，已取消请求不继续探测，非法显式代理不能悄悄改走其他出口", async () => {
  assert.equal(await diagnosticProxy("https://collector.test/events", signal(), { env: {}, platform: "darwin", readSystem: async () => { throw new Error("unavailable"); } }), null);
  for (const value of ["socks5://127.0.0.1:7897", "http://proxy.test/path", "http://proxy.test/?token=hidden"])
    await assert.rejects(diagnosticProxy("https://collector.test/events", signal(), { env: { HTTPS_PROXY: value } }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(diagnosticProxy("https://collector.test/events", controller.signal, { env: {} }), { name: "AbortError" });
});

test("代理隧道真实传输批次并校验确认，凭证只交给接收端，断连有界退出且不改全局 fetch", async t => {
  const originalFetch = globalThis.fetch, sockets = new Set<Socket>(); let tunnels = 0, backendCalls = 0;
  const backend = createServer(async (request, response) => {
    backendCalls++; assert.equal(request.headers.authorization, "Bearer isolated-transport-token");
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const batch = JSON.parse(Buffer.concat(chunks).toString());
    response.end(JSON.stringify({ batch_id: batch.batch_id, acknowledged: batch.events.length }));
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    tunnels++; assert.equal(request.url, "collector.test:80"); assert.equal(request.headers.authorization, undefined);
    const upstream = connect((backend.address() as { port: number }).port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); backend.closeAllConnections(); backend.close(); });
  const options = { env: { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` }, platform: "linux" as const };
  const batch = { batch_id: "synthetic-batch", events: [1] };
  const input = { endpoint: "http://collector.test/events", token: "isolated-transport-token", body: JSON.stringify(batch), signal: signal() };
  assert.deepEqual(await sendDiagnosticBatch(input, options), { batch_id: "synthetic-batch", acknowledged: 1 });
  assert.equal(tunnels, 1); assert.equal(backendCalls, 1); assert.equal(globalThis.fetch, originalFetch);
  // 代理已关闭时不回退到未经选择的直连路径，也不能留下无限存活的连接。
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await assert.rejects(sendDiagnosticBatch({ ...input, signal: AbortSignal.timeout(200) }, options));
  assert.equal(backendCalls, 1);
});
