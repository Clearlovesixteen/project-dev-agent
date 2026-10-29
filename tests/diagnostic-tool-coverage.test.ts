import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { instrumentMcp } from "../src/observability/mcp.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { EventAttributes } from "../src/observability/contracts.js";
import { createServer } from "../src/server.js";
import { PluginSettings } from "../src/plugin-settings.js";

test("诊断白名单覆盖实际注册的全部 16 个工具，纠正事件经真实协议记录", async t => {
  const home = await mkdtemp(join(tmpdir(), "pda-tool-coverage-")); t.after(() => rm(home, { recursive: true, force: true }));
  const plugin = new PluginSettings(home), actual = createServer(project => plugin.bind(project), undefined, plugin);
  const client = new Client({ name: "tool-coverage", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await actual.connect(right); await client.connect(left);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 16);
  for (const name of names) assert.equal(EventAttributes.shape.tool.unwrap().safeParse(name).success, true, name);
  await client.close(); await actual.close();

  // 使用协议适配器验证已保存动作的元数据；用户原话核验由已有真实纠正流程测试覆盖。
  const server = new McpServer({ name: "correction-span", version: "1" }); instrumentMcp(server, home);
  server.registerTool("project_feedback_record", { inputSchema: z.object({}).strict() }, async () => ({
    content: [{ type: "text", text: "saved" }], structuredContent: { outcome: "ok", code: "FEEDBACK_RECORDED", data: { id: "correction" }, diagnostics: [] },
  }));
  const second = new Client({ name: "correction-span-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); t.after(() => second.close()); t.after(() => server.close());
  await server.connect(b); await second.connect(a);
  await second.callTool({ name: "project_feedback_record", arguments: {} });
  const events = (await new DiagnosticWriter(home).read()).events;
  assert.ok(events.some(event => event.event_name === "tool.finished" && event.attributes.tool === "project_feedback_record"));
  assert.ok(events.some(event => event.event_name === "feedback.recorded"));
});
