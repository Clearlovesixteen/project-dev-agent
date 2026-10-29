import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { DiagnosticWriter } from "../src/observability/writer.js";

const entry = fileURLToPath(new URL("../../plugins/project-dev-agent/runtime/hooks.mjs", import.meta.url));
async function run(home: string, input: string, end = true) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("独立钩子未在外部测试预算内结束")); }, 6000);
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
  const blocked = await run(home, "{", false);
  assert.equal(blocked.code, 0); assert.deepEqual(JSON.parse(blocked.stdout), {});
  assert.ok((await new DiagnosticWriter(home).read()).events.some(event => event.reason_code === "HOOK_DEADLINE"));
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
