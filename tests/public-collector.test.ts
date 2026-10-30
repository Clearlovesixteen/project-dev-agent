import assert from "node:assert/strict";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../tools/diagnostics-collector/worker.js";
import { PUBLISHED_DIAGNOSTICS } from "../src/runtime/published-diagnostics.js";
import { initializePublishedDiagnostics } from "../src/runtime/diagnostics-bootstrap.js";
import { DiagnosticWriter } from "../src/observability/writer.js";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
async function setup(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pda-public-collector-")); t.after(() => rm(home, { recursive: true, force: true }));
  await initializePublishedDiagnostics(home); await new DiagnosticWriter(home).record("health.checked", { reason: "ISOLATED_PUBLIC_INGEST" });
  const events = (await new DiagnosticWriter(home).read()).events;
  const batch = { schema_version: 1, batch_id: createHash("sha256").update(JSON.stringify(events)).digest("hex"), events };
  const stored = new Map<string, unknown[]>(), keys: string[] = []; let blocked = "", failed = false;
  const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !blocked || !key.startsWith(blocked) }; } };
  const env = { WRITE_TOKEN: "private-owner-write-token", PUBLIC_SOURCE_LIMIT: limiter, PUBLIC_TOTAL_LIMIT: limiter,
    DIAGNOSTICS_DB: { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ values, run: async () => ({}) }) }),
      batch: async (rows: { values: unknown[] }[]) => { if (failed) throw new Error("private database error");
        for (const row of rows) stored.set(`${row.values[0]}:${row.values[1]}`, row.values); return []; } } };
  const send = (body: unknown = batch, options: { path?: string; token?: string; method?: string; missingLimits?: boolean } = {}) => worker.fetch(new Request(
    `https://collector.example${options.path ?? "/public/events"}`, { method: options.method ?? "POST", headers: {
      Authorization: `Bearer ${options.token ?? PUBLISHED_DIAGNOSTICS.ingest_key}`, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.17" },
      ...((options.method ?? "POST") === "POST" ? { body: JSON.stringify(body) } : {}) }),
    (options.missingLimits ? { ...env, PUBLIC_SOURCE_LIMIT: undefined } : env) as never);
  return { batch, send, stored, keys, block: (prefix: string) => { blocked = prefix; }, fail: () => { failed = true; } };
}

test("公开标识只写公开入口，不能用于私有入口、读数据或绕过字段白名单", async t => {
  const { batch, send, stored } = await setup(t);
  assert.equal((await send(batch, { path: "/events" })).status, 401);
  assert.equal((await send(batch, { token: "not-the-public-identifier" })).status, 401);
  assert.equal((await send(undefined, { method: "GET" })).status, 404);
  assert.equal((await send(batch, { path: "/admin" })).status, 404);
  assert.equal((await send({ ...batch, raw_prompt: "never accepted" })).status, 400);
  assert.equal((await send({ ...batch, events: batch.events.map(event => ({ ...event, raw_path: "/private/example" })) })).status, 400);
  assert.equal(stored.size, 0);
  assert.deepEqual(await (await send()).json(), { batch_id: batch.batch_id, acknowledged: 1 });
  assert.equal(stored.size, 1); assert.equal([...stored.values()][0]?.[9], "public");
  assert.ok(!JSON.stringify([...stored.values()]).includes("192.0.2.17"));
});

test("公开上报确认后可安全重试，数据库失败不能假确认，私有旧客户端继续使用原入口", async t => {
  const { batch, send, stored } = await setup(t);
  assert.equal((await send()).status, 200); assert.equal((await send()).status, 200); assert.equal(stored.size, 1);
  assert.equal((await send(batch, { path: "/events", token: "private-owner-write-token" })).status, 200);
  const failing = await setup(t); failing.fail();
  const response = await failing.send(); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "COLLECTOR_UNAVAILABLE" }); assert.equal(failing.stored.size, 0);
});

test("来源、安装与总量限流均先于入库，限流器缺失时关闭公开接收但保留私有入口", async t => {
  for (const prefix of ["source:", "install:", "public-diagnostics"]) {
    const { send, stored, block, keys } = await setup(t); block(prefix);
    const response = await send(); assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(stored.size, 0); assert.ok(keys.some(key => key.startsWith(prefix)));
    assert.ok(keys.every(key => !key.includes("192.0.2.17")));
  }
  const { batch, send, stored } = await setup(t);
  assert.equal((await send(batch, { missingLimits: true })).status, 503); assert.equal(stored.size, 0);
  assert.equal((await send(batch, { missingLimits: true, path: "/events", token: "private-owner-write-token" })).status, 200);
});
