import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { TaskStore } from "../src/storage/task-store.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { handleHook } from "../src/hooks/handler.js";

const installed = fileURLToPath(new URL("../../plugins/project-dev-agent/", import.meta.url));
const execute = promisify(execFile);
async function setup(t: test.TestContext, openTask = true) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "readonly-home"); await mkdir(home);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { upload: false } });
  const env = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home };
  const client = new Client({ name: "readonly-regression", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["runtime/cli.mjs", "serve", "--plugin"], cwd: installed, env, stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name: string, input: Record<string, unknown> = {}, session = "task-owner") => {
    const result = await client.callTool({ name, arguments: { project: fixture.path, ...input,
      interaction: { session_id: session, turn_id: `${session}-turn` } } });
    const value = result.structuredContent as { outcome: string; data: any };
    assert.notEqual(value.outcome, "error", JSON.stringify(value)); return value;
  };
  await call("project_prepare", { apply: true }); await call("project_scan");
  const opened = openTask ? await call("task_open", { requirement: "保留另一会话的任务以验证读取隔离", acceptance_criteria: [{ id: "keep", description: "原任务保持" }] }) : undefined;
  const taskId = opened?.data.id as string | undefined, store = new TaskStore(fixture.path), original = taskId ? JSON.stringify(await store.load(taskId)) : undefined;
  const run = (command: string, extra: Record<string, unknown> = {}) => new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(process.execPath, [join(installed, "runtime/hooks.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("只读钩子未在宿主预算内完成")); }, 8000);
    child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; });
    child.on("error", reject); child.on("close", code => { clearTimeout(timer);
      try { assert.equal(code, 0); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", cwd: fixture.path, session_id: "readonly-reader", turn_id: "readonly-reader-turn",
      tool_name: "Bash", tool_use_id: "readonly-probe", tool_input: { command }, ...extra }));
  });
  const unchanged = async () => taskId ? assert.equal(JSON.stringify(await store.load(taskId)), original) : assert.equal(await store.active("main"), undefined);
  return { fixture, home, env, run, call, unchanged };
}

test("真实发布钩子：其他会话有任务也允许正则读取，既不要求上下文也不修改原任务", async t => {
  const s = await setup(t);
  for (const command of ['rg -n "loadDetails|invoke" src', "rg -n 'loadDetails|invoke' src", 'cat src/auth.js | head -n 2'])
    assert.equal((await s.run(command)).hookSpecificOutput?.permissionDecision, undefined, command);
  await s.unchanged();
  const events = (await new DiagnosticWriter(s.home).read()).events;
  assert.ok(events.some(event => event.event_name === "decision.recorded" && event.reason_code.startsWith("COMMAND_READ_ONLY_")));
  assert.ok(!JSON.stringify(events).includes("loadDetails|invoke"));
  assert.ok(!JSON.stringify(events).includes(s.fixture.path));
});

test("读取上下文后 Windows 命令仍无任务门禁；真实跨会话修改继续拒绝", async t => {
  const s = await setup(t);
  await s.call("project_context", { query: "auth", paths: ["src/auth.js"] }, "readonly-reader");
  for (const command of ['rg.exe -n "load|invoke" src', 'powershell.exe -NoProfile -Command "Get-Content src/auth.js | Select-Object -First 2"'])
    assert.equal((await s.run(command)).hookSpecificOutput?.permissionDecision, undefined, command);
  for (const command of ['Get-Content src/auth.js', 'Select-String -Path src/auth.js -Pattern "load|invoke"'])
    assert.equal((await s.run(command, { tool_input: { command, shell: "pwsh.exe" } })).hookSpecificOutput?.permissionDecision, undefined, command);
  const edit = await s.run("unused", { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.js\n@@\n+// 修改\n*** End Patch" } });
  assert.equal(edit.hookSpecificOutput?.permissionDecision, "deny"); assert.match(edit.hookSpecificOutput.permissionDecisionReason, /本分支任务属于另一聊天/);
  for (const command of ['rg load src > result.txt', 'Get-Content src/auth.js | Set-Content other.js']) {
    const output = await s.run(command, { tool_input: { command, shell: command.startsWith("Get-") ? "pwsh.exe" : "bash" } });
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny", command);
  }
  const unknown = await s.run('node -e "console.log(1)"');
  assert.equal(unknown.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(unknown.hookSpecificOutput.permissionDecisionReason, /尚不能可靠确认是否只读/);
  await s.unchanged();
});

test("当前操作系统真实执行读取管道，发布钩子不要求接管另一会话", async t => {
  const s = await setup(t);
  const source = await readFile(join(s.fixture.path, "src/auth.js"), "utf8");
  const command = process.platform === "win32" ? "Get-Content -LiteralPath 'src/auth.js' | Select-Object -First 2" : "sed -n '1,2p' src/auth.js | head -n 2";
  assert.equal((await s.run(command)).hookSpecificOutput?.permissionDecision, undefined);
  const actual = process.platform === "win32"
    ? await execute("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: s.fixture.path, env: { ...process.env, ...s.env }, timeout: 15000 })
    : await execute("/bin/sh", ["-c", command], { cwd: s.fixture.path, env: s.env, timeout: 15000 });
  assert.equal(actual.stdout.replace(/\r\n/g, "\n").trim(), source.split(/\r?\n/).slice(0, 2).join("\n").trim());
  await s.unchanged();
});

test("真实发布钩子：nl和stdin范围阅读在无任务或其他会话任务下均放行，写入仍被阻止", async t => {
  for (const openTask of [false, true]) await t.test(openTask ? "保留其他会话任务" : "不创建阅读任务", async t => {
    const s = await setup(t, openTask);
    for (const command of ["nl -ba src/auth.js", "nl -ba src/auth.js | sed -n '1,2p'", "cat src/auth.js | sed -n '1,2p'",
      "git status --short && nl -ba src/auth.js", "bash -lc 'nl -ba src/auth.js | head -n 2'"])
      assert.equal((await s.run(command)).hookSpecificOutput?.permissionDecision, undefined, command);
    await s.call("project_context", { query: "auth", paths: ["src/auth.js"] }, "readonly-reader");
    for (const command of ["nl -ba src/auth.js > result.txt", "nl -ba src/auth.js | tee result.txt",
      "nl -ba src/auth.js; touch result.txt", "cat src/auth.js | sed -n '1,2w result.txt'",
      "cat src/auth.js | sed -n '1,2p; e touch result.txt'", "nl -ba src/auth.js | node -e 'write()'"]) {
      const denied = (await s.run(command)).hookSpecificOutput;
      assert.equal(denied?.permissionDecision, "deny", command);
      assert.match(denied.permissionDecisionReason, openTask ? /本分支任务属于另一聊天/ : /本分支没有活跃任务/);
    }
    if (process.platform !== "win32") {
      const actual = await execute("/bin/sh", ["-c", "nl -ba src/auth.js | sed -n '1,2p'"], { cwd: s.fixture.path, env: s.env, timeout: 15000 });
      const expected = (await readFile(join(s.fixture.path, "src/auth.js"), "utf8")).split(/\r?\n/).slice(0, 2);
      assert.deepEqual(actual.stdout.replace(/\r?\n$/, "").split(/\r?\n/).map(line => line.replace(/^\s*\d+\t/, "")), expected);
    }
    await s.unchanged();
  });
});

test("读取分类诊断挂起时仍有界放行，不影响本来允许的读取", async t => {
  const s = await setup(t), previous = DiagnosticWriter.prototype.record;
  DiagnosticWriter.prototype.record = async () => new Promise(() => {});
  t.after(() => { DiagnosticWriter.prototype.record = previous; });
  const started = performance.now();
  const result = await handleHook({ hook_event_name: "PreToolUse", cwd: s.fixture.path, session_id: "reader", tool_name: "Bash",
    tool_input: { command: 'rg -n "load|invoke" src' } }, installed, s.home);
  assert.deepEqual(result, {}); assert.ok(performance.now() - started < 1000);
});
