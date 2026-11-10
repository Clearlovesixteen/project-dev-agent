import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RuntimeSettings } from "../src/runtime/config.js";

const packageRoot = fileURLToPath(new URL("../../plugins/project-dev-agent/", import.meta.url));
const execute = promisify(execFile);
async function legacyHome(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pda-activation-startup-")); t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "project-dev-agent"));
  const path = join(home, "project-dev-agent/runtime.json");
  const prior = { schema_version: 1, revision: randomUUID(), mode: "manual", mode_origin: "user",
    diagnostics: { local: false, upload: false, endpoint: null, write_token: null, notice_version: null, enabled_at: null, upload_epoch: null } };
  await writeFile(path, JSON.stringify(prior));
  return { home, path, prior, env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home } };
}

test("真实打包 MCP 加载即迁移旧 manual，不依赖模型或用户先调用设置", async t => {
  const s = await legacyHome(t);
  const start = async () => {
    const client = new Client({ name: "activation-upgrade-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["runtime/cli.mjs", "serve", "--plugin"],
      cwd: packageRoot, env: s.env, stderr: "pipe" });
    await client.connect(transport); return client;
  };
  const first = await start(); t.after(() => first.close());
  let config = await new RuntimeSettings(s.home).current();
  assert.equal(config.mode, "auto"); assert.equal(config.mode_origin, "upgrade");
  assert.deepEqual(config.diagnostics, s.prior.diagnostics);
  const status = await first.callTool({ name: "plugin_status", arguments: {} });
  assert.equal((status.structuredContent as any).data.runtime.activation.state, "enabled");
  await assert.rejects(readFile(join(s.home, "project-dev-agent/settings.json")), { code: "ENOENT" });
  await first.close();
  await new RuntimeSettings(s.home).configure({ apply: true, expected_revision: config.revision, mode: "manual" });
  const disabled = await readFile(s.path, "utf8"), second = await start(); t.after(() => second.close());
  assert.equal(await readFile(s.path, "utf8"), disabled);
  config = await new RuntimeSettings(s.home).current(); assert.equal(config.mode, "manual");
  await second.close();
});

test("真实 CLI 设置入口自动迁移，后续 status 不重复更改修订", async t => {
  const s = await legacyHome(t);
  const command = () => execute(process.execPath, [join(packageRoot, "runtime/cli.mjs"), "runtime", "status"], { cwd: s.home, env: s.env, timeout: 10000 });
  const first = JSON.parse((await command()).stdout);
  assert.equal(first.mode, "auto"); assert.equal(first.activation.mode_origin, "upgrade");
  const migrated = await readFile(s.path, "utf8"); await command();
  assert.equal(await readFile(s.path, "utf8"), migrated);
  assert.deepEqual((await new RuntimeSettings(s.home).current()).diagnostics, s.prior.diagnostics);
});
