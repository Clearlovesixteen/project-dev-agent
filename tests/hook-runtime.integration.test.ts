import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { DIAGNOSTIC_NOTICE, RuntimeSettings } from "../src/runtime/config.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { PUBLISHED_DIAGNOSTICS } from "../src/runtime/published-diagnostics.js";

const entry = fileURLToPath(new URL("../../plugins/project-dev-agent/runtime/hooks.mjs", import.meta.url));
async function run(home: string, input: string, end = true) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("独立钩子未在外部测试预算内结束")); }, 9000);
    child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; });
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    if (end) child.stdin.end(input); else child.stdin.write(input);
  });
}

test("独立钩子面对无效/超限/未结束输入都返回单个 JSON，不拖住正常会话", async t => {
  const home = await mkdtemp(join(tmpdir(), "pda-hook-entry-")); t.after(() => rm(home, { recursive: true, force: true }));
  for (const input of ["invalid-json", "x".repeat(262145)]) {
    const result = await run(home, input); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), {}); assert.equal(result.stderr, "");
  }
  const started = performance.now(), blocked = await run(home, "{", false);
  assert.equal(blocked.code, 0); assert.deepEqual(JSON.parse(blocked.stdout), {});
  assert.ok(performance.now() - started < 5000, "未结束输入应有界退出，不能一直占用会话");
  // 截止事件是尽力记录；重载时硬期限可以先于磁盘写入结束，不能把正常降级误判为失败。
  assert.equal((await new DiagnosticWriter(home).read()).invalid, 0);
});

test("真实打包入口在 auto 下输出路由，只有写出 stdout 才计 emitted，未开远程不会发送", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex-home"); await mkdir(home);
  await new PluginSettings(home).prepare(fixture.path, { apply: true });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto" });
  const result = await run(home, JSON.stringify({ hook_event_name: "SessionStart", session_id: "entry-session", cwd: fixture.path, source: "startup" }));
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout); assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Project Dev Agent"));
  const events = (await new DiagnosticWriter(home).read()).events;
  assert.equal(events.filter(event => event.event_name === "context.emitted").length, 1);
  assert.equal((await new RuntimeSettings(home).current()).diagnostics.upload, false);
});

test("异步 Stop 等待慢速持久确认再推进队列，同步输入钩子的期限不受影响", async t => {
  const home = await mkdtemp(join(tmpdir(), "pda-stop-ack-")); t.after(() => rm(home, { recursive: true, force: true }));
  let received = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const batch = JSON.parse(Buffer.concat(chunks).toString()); received += batch.events.length;
    setTimeout(() => response.end(JSON.stringify({ batch_id: batch.batch_id, acknowledged: batch.events.length })), 1800);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, diagnostics: {
    upload: true, notice_version: DIAGNOSTIC_NOTICE,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/events`, write_token: "isolated-hook-write-token" } });
  await new DiagnosticWriter(home).record("health.checked", { reason: "ISOLATED_STOP_TEST" });
  const result = await run(home, JSON.stringify({ hook_event_name: "Stop", session_id: "isolated-stop", cwd: home }));
  assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), {});
  const cursor = JSON.parse(await readFile(join(home, "project-dev-agent/telemetry/upload.json"), "utf8"));
  assert.equal(cursor.failures, 0, "持久确认已收到时不能仍保留失败游标");
  assert.ok(Object.values(cursor.positions).some(value => Number(value) >= 2));
  assert.equal(received, 2);
  const events = (await new DiagnosticWriter(home).read()).events;
  assert.ok(events.some(event => event.event_name === "hook.finished"));
  assert.ok(!events.some(event => event.reason_code === "HOOK_DEADLINE"));
});

test("新安装的真实钩子自动初始化公开上报，保存关闭后重启不重新开启", async t => {
  const home = await mkdtemp(join(tmpdir(), "pda-hook-public-")); t.after(() => rm(home, { recursive: true, force: true }));
  const first = await run(home, JSON.stringify({ hook_event_name: "SessionStart", session_id: "fresh-install", cwd: home }));
  assert.equal(first.code, 0); assert.equal(first.stderr, "");
  const settings = new RuntimeSettings(home), config = await settings.current();
  assert.equal(config.diagnostics.upload, true); assert.equal(config.diagnostics.endpoint, PUBLISHED_DIAGNOSTICS.endpoint);
  await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { upload: false } });
  const revision = (await settings.current()).revision;
  const stopped = await run(home, JSON.stringify({ hook_event_name: "Stop", session_id: "fresh-install", cwd: home }));
  assert.equal(stopped.code, 0); assert.deepEqual(JSON.parse(stopped.stdout), {});
  assert.equal((await settings.current()).diagnostics.upload, false); assert.equal((await settings.current()).revision, revision);
});
