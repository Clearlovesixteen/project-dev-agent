import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializePublishedDiagnostics } from "../src/runtime/diagnostics-bootstrap.js";
import { PUBLISHED_DIAGNOSTICS } from "../src/runtime/published-diagnostics.js";
import { DIAGNOSTIC_NOTICE, RuntimeSettings } from "../src/runtime/config.js";
import { DiagnosticWriter } from "../src/observability/writer.js";

async function setup(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pda-public-default-")); t.after(() => rm(home, { recursive: true, force: true }));
  return { home, settings: new RuntimeSettings(home), path: join(home, "project-dev-agent/runtime.json") };
}

test("首次启动初始化公开上报，不要求用户配置凭证；启用前的本地记录不进入新周期", async t => {
  const { home, settings, path } = await setup(t), writer = new DiagnosticWriter(home);
  await writer.record("health.checked", { reason: "BEFORE_DEFAULT_INITIALIZATION" });
  assert.equal((await initializePublishedDiagnostics(home)).state, "initialized");
  const config = await settings.current();
  assert.equal(config.mode, "manual"); assert.equal(config.diagnostics.upload, true);
  assert.equal(config.diagnostics.endpoint, PUBLISHED_DIAGNOSTICS.endpoint);
  assert.equal(config.diagnostics.write_token, PUBLISHED_DIAGNOSTICS.ingest_key);
  assert.equal(config.diagnostics.notice_version, DIAGNOSTIC_NOTICE); assert.ok(config.diagnostics.upload_epoch);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writer.record("health.checked", { reason: "AFTER_DEFAULT_INITIALIZATION" });
  const events = (await writer.read()).events;
  assert.equal(events[0]?.upload_epoch, null); assert.equal(events[1]?.upload_epoch, config.diagnostics.upload_epoch);
  const status = await settings.status(); assert.equal(status.diagnostics.collector_kind, "published_public_ingest");
  assert.ok(!JSON.stringify(status).includes(PUBLISHED_DIAGNOSTICS.ingest_key));
});

test("关闭上传或关闭本地采集后，重启和更新都不能重新打开默认上报", async t => {
  const { home, settings, path } = await setup(t);
  await initializePublishedDiagnostics(home);
  let config = await settings.current();
  await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { upload: false } });
  let original = await readFile(path, "utf8");
  assert.equal((await initializePublishedDiagnostics(home)).state, "preserved");
  assert.equal(await readFile(path, "utf8"), original); assert.equal((await settings.current()).diagnostics.upload, false);
  config = await settings.current();
  await settings.configure({ apply: true, expected_revision: config.revision, diagnostics: { local: false } });
  original = await readFile(path, "utf8"); await initializePublishedDiagnostics(home);
  assert.equal(await readFile(path, "utf8"), original); assert.equal((await settings.current()).diagnostics.local, false);
});

test("旧版已保存的关闭状态和自定义接收配置均按原字节保留，不覆盖旧用户选择", async t => {
  for (const upload of [false, true]) {
    const { home, settings, path } = await setup(t);
    await settings.configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: upload ? {
      upload: true, endpoint: "https://private.example/events", write_token: "existing-private-write-token", notice_version: DIAGNOSTIC_NOTICE,
    } : { upload: false } });
    const original = await readFile(path, "utf8");
    assert.equal((await initializePublishedDiagnostics(home)).state, "preserved");
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("旧用户主动开启默认接收端无需填写凭证，预览不保存，并拒绝混用另一组地址", async t => {
  const { home, settings, path } = await setup(t);
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { upload: false } });
  const before = await readFile(path, "utf8");
  const preview = await settings.configure({ diagnostics: { use_default: true } });
  assert.equal(await readFile(path, "utf8"), before);
  assert.ok("expected_revision" in preview);
  await settings.configure({ apply: true, expected_revision: preview.expected_revision, diagnostics: { use_default: true } });
  assert.equal((await settings.current()).diagnostics.upload, true);
  assert.equal((await settings.current()).diagnostics.write_token, PUBLISHED_DIAGNOSTICS.ingest_key);
  await assert.rejects(settings.configure({ diagnostics: { use_default: true, endpoint: "https://other.example/events" } }), { code: "DIAGNOSTICS_DEFAULT_CONFLICT" });
  assert.equal((await initializePublishedDiagnostics(home)).state, "preserved");
});

test("并发首次初始化只有一个配置周期，后续重试不能重置游标对应的周期", async t => {
  const { home, settings, path } = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => initializePublishedDiagnostics(home)));
  assert.equal(results.filter(value => value.state === "initialized").length, 1);
  const original = await readFile(path, "utf8"), epoch = (await settings.current()).diagnostics.upload_epoch;
  await initializePublishedDiagnostics(home);
  assert.equal(await readFile(path, "utf8"), original); assert.equal((await settings.current()).diagnostics.upload_epoch, epoch);
});

test("损坏配置与目录链接不被默认策略覆盖，初始化失败不阻断其他流程", async t => {
  const { home, path } = await setup(t); await mkdir(join(home, "project-dev-agent")); await writeFile(path, "broken");
  assert.equal((await initializePublishedDiagnostics(home)).state, "unavailable"); assert.equal(await readFile(path, "utf8"), "broken");
  const linked = await setup(t), outside = await setup(t); await symlink(outside.home, join(linked.home, "project-dev-agent"));
  assert.equal((await initializePublishedDiagnostics(linked.home)).state, "unavailable");
  await assert.rejects(readFile(join(outside.home, "runtime.json")), { code: "ENOENT" });
});
