import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { runSlowSessionStart } from "./helpers/run-slow-session-start.js";
import { DIAGNOSTIC_NOTICE, RuntimeSettings } from "../src/runtime/config.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { uploadDiagnostics } from "../src/observability/uploader.js";
import { PUBLISHED_DIAGNOSTICS } from "../src/runtime/published-diagnostics.js";

const entry = fileURLToPath(new URL("../../plugins/project-dev-agent/runtime/hooks.mjs", import.meta.url));
async function run(home: string, input: string, end = true, extraEnv: NodeJS.ProcessEnv = {}, executable = entry) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [executable], { env: { ...process.env, CODEX_HOME: home, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
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

test("已打包的 UserPromptSubmit 使用独立轻量入口，其他四项仍指向真实运行时", async t => {
  const root = fileURLToPath(new URL("../../plugins/project-dev-agent/", import.meta.url));
  const config = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8"));
  for (const name of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"])
    assert.equal(config.hooks[name][0].hooks[0].command, 'node "${PLUGIN_ROOT}/runtime/hooks.mjs"');
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].command, 'node "${PLUGIN_ROOT}/hooks/prompt.mjs"');
  const home = await mkdtemp(join(tmpdir(), "pda-prompt-only-")); t.after(() => rm(home, { recursive: true, force: true }));
  const result = await run(home, JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "长".repeat(60_000) }),
    true, {}, join(root, "hooks/prompt.mjs"));
  assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.equal(result.stdout, "{}\n");
  await assert.rejects(readFile(join(home, "project-dev-agent/runtime.json")), { code: "ENOENT" });
});

test("真实打包入口在 auto 下输出路由，只有写出 stdout 才计 emitted，未开远程不会发送", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex-home"); await mkdir(home);
  await new PluginSettings(home).prepare(fixture.path, { apply: true });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto" });
  const parsed = runSlowSessionStart(home, { session_id: "entry-session", cwd: fixture.path, source: "startup" });
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Project Dev Agent"));
  const events = (await new DiagnosticWriter(home).read()).events;
  assert.equal(events.filter(event => event.event_name === "context.emitted").length, 1);
  assert.deepEqual(events.filter(event => event.event_name === "hook.finished").map(event => event.outcome), ["ok"]);
  assert.equal((await new RuntimeSettings(home).current()).diagnostics.upload, false);
});

test("真实运行包的修改前钩子会拒绝未查询上下文的补丁，标准输出保留宿主拒绝格式", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "guard-codex-home"); await mkdir(home);
  await new PluginSettings(home).prepare(fixture.path, { apply: true });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { upload: false } });
  const result = await run(home, JSON.stringify({ hook_event_name: "PreToolUse", session_id: "packaged-guard", turn_id: "guard-turn",
    cwd: fixture.path, tool_name: "apply_patch", tool_use_id: "patch-one",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.js\n@@\n+// 未准备的修改\n*** End Patch" } }));
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse"); assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /project_context/);
  assert.equal((await new RuntimeSettings(home).current()).diagnostics.upload, false);
});

test("发布钩子清单给 PreToolUse 保留足够的宿主预算", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "hooks/hooks.json"), "utf8"));
  const preToolUse = manifest.hooks.PreToolUse[0].hooks[0];
  const sessionStart = manifest.hooks.SessionStart[0].hooks[0];
  const stop = manifest.hooks.Stop[0].hooks[0];
  assert.equal(preToolUse.timeout, 8);
  assert.equal(sessionStart.timeout, 3);
  assert.equal(stop.timeout, 8);
});

test("更新后的独立钩子自动迁移旧 manual，保留诊断关闭且重启幂等", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "upgrade-hook-home"); await mkdir(home);
  await new PluginSettings(home).prepare(fixture.path, { apply: true });
  const settings = new RuntimeSettings(home);
  await settings.configure({ apply: true, expected_revision: null, mode: "manual", diagnostics: { upload: false } });
  const path = join(home, "project-dev-agent/runtime.json"), legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.activation_policy_version;
  await writeFile(path, JSON.stringify(legacy));
  const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "upgrade-packaged-hook", cwd: fixture.path, source: "startup" });
  const first = await run(home, input); assert.equal(first.code, 0); assert.equal(first.stderr, "");
  assert.match(JSON.parse(first.stdout).hookSpecificOutput?.additionalContext, /Project Dev Agent 自动参与入口/);
  assert.equal((await settings.current()).mode, "auto"); assert.equal((await settings.current()).mode_origin, "upgrade");
  assert.deepEqual((await settings.current()).diagnostics, legacy.diagnostics);
  const migrated = await readFile(path, "utf8");
  const second = await run(home, input); assert.equal(second.code, 0);
  assert.equal(await readFile(path, "utf8"), migrated);
});

test("会话入口 Git 发现超时仍保留轻量入口，诊断指出具体检查阶段", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "slow-hook-home"), bin = join(fixture.root, "slow-bin"); await mkdir(home); await mkdir(bin);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { upload: false } });
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(bin, "git");
  await writeFile(wrapper, `#!/bin/sh\nsleep 2\nexec '${git.replace(/'/g, "'\\''")}' "$@"\n`); await chmod(wrapper, 0o755);
  // 普通提示不会触发 Git 发现；慢 Git 下也无需回退或追加工作流说明。
  const prompt = await run(home, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "ordinary-prompt",
    cwd: fixture.path, prompt: "看看这个接口有什么作用" }), true, { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.deepEqual(JSON.parse(prompt.stdout), {});
  const result = await run(home, JSON.stringify({ hook_event_name: "SessionStart", session_id: "slow-discovery",
    turn_id: "slow-prompt", cwd: fixture.path, prompt: "更新账户业务" }), true,
    { PATH: `${bin}:${process.env.PATH ?? ""}` });
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput?.additionalContext, /project_prepare/);
  assert.match(output.hookSpecificOutput?.additionalContext, /摘要尚未就绪/);
  assert.match(output.systemMessage, /HOOK_DEADLINE/);
  const writer = new DiagnosticWriter(home);
  const deadline = (await writer.read()).events.find(event => event.reason_code === "HOOK_DEADLINE");
  assert.ok(deadline);
  assert.equal(deadline.trace_id, await writer.opaque("slow-prompt"));
  assert.equal(deadline.attributes.event, "SessionStart");
  assert.equal(deadline.context?.stage, "scope");
  assert.ok(deadline.call_id && deadline.duration_ms >= 1000);
});

test("Stop 先完整落盘并快速返回，下一次入口再消费收尾队列", async t => {
  const home = await mkdtemp(join(tmpdir(), "pda-stop-ack-")); t.after(() => rm(home, { recursive: true, force: true }));
  let received = 0; const profiles: number[] = [], names: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const batch = JSON.parse(Buffer.concat(chunks).toString()); received += batch.events.length; profiles.push(batch.schema_version);
    names.push(...batch.events.map((event: { event_name: string }) => event.event_name));
    // 新版Stop含结构化诊断，接收端必须按v2逐项持久确认，不能在新入口伪装成旧ACK。
    const ack = batch.schema_version === 2
      ? { schema_version: 2, batch_id: batch.batch_id, accepted_indexes: batch.events.map((_event: unknown, index: number) => index), rejected: [] }
      : { batch_id: batch.batch_id, acknowledged: batch.events.length };
    setTimeout(() => response.end(JSON.stringify(ack)), 1800);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, diagnostics: {
    upload: true, notice_version: DIAGNOSTIC_NOTICE,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/events`, write_token: "isolated-hook-write-token" } });
  await new DiagnosticWriter(home).record("health.checked", { reason: "ISOLATED_STOP_TEST" });
  const started = performance.now();
  const result = await run(home, JSON.stringify({ hook_event_name: "Stop", session_id: "isolated-stop", cwd: home }));
  assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), {});
  const stopDuration = performance.now() - started;
  assert.equal(received, 0, "Stop 返回前接收端不应收到任何网络请求");
  assert.ok(stopDuration < 1000, `Stop 不应等待远程确认，实测 ${Math.round(stopDuration)}ms`);
  const localEvents = (await new DiagnosticWriter(home).read()).events;
  assert.ok(localEvents.some(event => event.event_name === "hook.finished"), "Stop 收尾事件必须先落盘");
  const drained = await uploadDiagnostics(home, 2500, await new RuntimeSettings(home).current());
  assert.equal(drained.state, "ok");
  const cursor = JSON.parse(await readFile(join(home, "project-dev-agent/telemetry/upload.json"), "utf8"));
  assert.equal(cursor.failures, 0, "持久确认已收到时不能仍保留失败游标");
  assert.ok(Object.values(cursor.positions).some(value => Number(value) >= 3));
  assert.ok(received >= 3);
  assert.ok(names.includes("hook.finished"), "下一次入口消费时应包含上次 Stop 的收尾事件");
  assert.deepEqual(profiles, [2]);
  assert.ok(!localEvents.some(event => event.reason_code === "HOOK_DEADLINE"));
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
