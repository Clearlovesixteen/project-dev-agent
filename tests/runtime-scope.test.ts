import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { createServer } from "../src/server.js";
import { ToolResultSchema } from "../src/domain/result.js";

test("MCP 注入配置目录后，运行设置和诊断都跟随该目录，不回落到其他用户配置", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const first = join(fixture.root, "profile-a"), second = join(fixture.root, "profile-b");
  await mkdir(first); await mkdir(second);
  const plugin = new PluginSettings(first); await plugin.prepare(fixture.path, { apply: true });
  const server = createServer(project => plugin.bind(project), undefined, plugin);
  const client = new Client({ name: "configuration-scope-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(() => client.close()); t.after(() => server.close());
  await server.connect(right); await client.connect(left);
  const call = async (name: string, args: Record<string, unknown> = {}) => ToolResultSchema.parse((await client.callTool({ name, arguments: args })).structuredContent);
  const status = (await call("plugin_status")).data as { revision: string };
  const result = await call("plugin_configure", { workspace: fixture.path, apply: true, expected_revision: status.revision,
    runtime: { expected_revision: null, mode: "observe" } });
  assert.equal(result.outcome, "ok");
  assert.equal((await new RuntimeSettings(first).current()).mode, "observe");
  assert.equal((await new RuntimeSettings(second).current()).mode, "manual");
  await assert.rejects(readFile(join(second, "project-dev-agent/runtime.json")), { code: "ENOENT" });
});
