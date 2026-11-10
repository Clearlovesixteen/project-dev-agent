import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGNOSTIC_NOTICE, RuntimeSettings } from "../src/runtime/config.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { handleHook } from "../src/hooks/handler.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { DiagnosticWriter } from "../src/observability/writer.js";

const context = (value: Record<string, unknown>) => (value.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
async function setup(t: test.TestContext, origin?: string) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = await mkdtemp(join(tmpdir(), "pda-auto-upgrade-")); t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new RuntimeSettings(home), plugin = new PluginSettings(home);
  await plugin.prepare(fixture.path, { apply: true });
  const path = join(home, "project-dev-agent/runtime.json");
  // 直接保存真实旧格式，不能通过新版配置接口构造“已经迁移”的假旧用户。
  const prior = { schema_version: 1, revision: randomUUID(), mode: "manual", ...(origin ? { mode_origin: origin } : {}),
    diagnostics: { local: false, upload: false, endpoint: "https://private.example/events", write_token: "private-existing-token-value", notice_version: null,
      enabled_at: null, upload_epoch: null } };
  await writeFile(path, JSON.stringify(prior), { mode: 0o600 });
  const run = (input: object = {}) => handleHook({ hook_event_name: "SessionStart", cwd: fixture.path, session_id: "upgrade-session", source: "startup", ...input }, "/installed/project-dev-agent", home);
  return { fixture, home, settings, plugin, path, prior, run };
}

test("旧版无来源或明确 manual 升级后自动参与，不再询问切换模式", async t => {
  for (const origin of [undefined, "user", "default"]) await t.test(origin ?? "legacy", async t => {
    const s = await setup(t, origin), workspace = await readFile(join(s.home, "project-dev-agent/settings.json"), "utf8");
    const output = await s.run();
    assert.ok(context(output).includes("Project Dev Agent 自动参与入口"), JSON.stringify(output));
    const config = await s.settings.current();
    assert.equal(config.mode, "auto"); assert.equal(config.mode_origin, "upgrade");
    assert.notEqual(config.revision, s.prior.revision);
    assert.deepEqual(config.diagnostics, s.prior.diagnostics);
    assert.equal(await readFile(join(s.home, "project-dev-agent/settings.json"), "utf8"), workspace);
    assert.equal((await stat(s.path)).mode & 0o777, 0o600);
    assert.equal((await s.settings.status()).activation.state, "enabled");
  });
});

test("迁移只执行一次；新版主动关闭后，重复启动不重启自动参与", async t => {
  const s = await setup(t, "user"); await s.run();
  assert.equal((await s.settings.current()).mode, "auto");
  const migrated = await readFile(s.path, "utf8");
  await s.run(); assert.equal(await readFile(s.path, "utf8"), migrated);
  await s.settings.configure({ apply: true, expected_revision: (await s.settings.current()).revision, mode: "manual" });
  const disabled = await readFile(s.path, "utf8");
  for (let i = 0; i < 2; i++) assert.deepEqual(await s.run(), {});
  assert.equal(await readFile(s.path, "utf8"), disabled);
  assert.equal((await s.settings.status()).activation.state, "disabled");
});

test("多个启动并发迁移后保留同一模式和诊断设置，重试不反复改写", async t => {
  const s = await setup(t);
  await Promise.all(Array.from({ length: 8 }, () => s.run()));
  assert.equal((await s.settings.current()).mode, "auto");
  assert.deepEqual((await s.settings.current()).diagnostics, s.prior.diagnostics);
  const migrated = await readFile(s.path, "utf8"); await s.run();
  assert.equal(await readFile(s.path, "utf8"), migrated);
});

test("迁移记录可供维护者诊断，关闭远程上报不影响自动迁移", async t => {
  const s = await setup(t);
  const legacy = { ...s.prior, diagnostics: { ...s.prior.diagnostics, local: true } };
  await writeFile(s.path, JSON.stringify(legacy));
  await s.run(); await s.run();
  const events = (await new DiagnosticWriter(s.home).read()).events;
  assert.equal(events.filter(event => event.reason_code === "MANUAL_UPGRADED_TO_AUTO").length, 1);
  assert.equal((await s.settings.current()).diagnostics.upload, false);
  assert.ok(!JSON.stringify(events).includes("private-existing-token-value"));
  assert.ok(!JSON.stringify(events).includes(s.fixture.path));
});

test("旧用户自定义远程接收端与原上传周期在模式升级中原样保留", async t => {
  const s = await setup(t);
  const diagnostics = { ...s.prior.diagnostics, local: true, upload: true, notice_version: DIAGNOSTIC_NOTICE,
    enabled_at: new Date().toISOString(), upload_epoch: randomUUID() };
  await writeFile(s.path, JSON.stringify({ ...s.prior, diagnostics })); await s.run();
  assert.equal((await s.settings.current()).mode, "auto");
  assert.deepEqual((await s.settings.current()).diagnostics, diagnostics);
});

test("旧 auto 和 observe 保持模式，旧默认缺失 mode 按 manual 自动迁移", async t => {
  for (const mode of ["auto", "observe", undefined]) await t.test(mode ?? "missing", async t => {
    const s = await setup(t), raw = { ...s.prior, mode };
    await writeFile(s.path, JSON.stringify(raw)); await s.run();
    assert.equal((await s.settings.current()).mode, mode ?? "auto");
    const original = await readFile(s.path, "utf8"); await s.run();
    assert.equal(await readFile(s.path, "utf8"), original);
    assert.deepEqual((await s.settings.current()).diagnostics, s.prior.diagnostics);
  });
});

test("迁移不覆盖损坏文件或链接目标；活跃配置锁释放后自动重试", async t => {
  const s = await setup(t), directory = join(s.home, "project-dev-agent");
  await writeFile(s.path, "broken"); await s.run(); assert.equal(await readFile(s.path, "utf8"), "broken");
  await writeFile(s.path, JSON.stringify(s.prior));
  const lock = join(directory, "runtime.lock"); await writeFile(lock, JSON.stringify({ pid: process.pid, token: randomUUID() }));
  await s.run(); assert.deepEqual(JSON.parse(await readFile(s.path, "utf8")), s.prior);
  await rm(lock); await s.run(); assert.equal((await s.settings.current()).mode, "auto");
  const outside = join(s.fixture.root, "outside-runtime.json"); await writeFile(outside, JSON.stringify(s.prior));
  await rm(s.path); await symlink(outside, s.path); await s.run();
  assert.deepEqual(JSON.parse(await readFile(outside, "utf8")), s.prior);
});
