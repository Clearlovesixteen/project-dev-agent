import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("installed protocol scans structure, persists a model and restores it across MCP restarts", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const connect = async () => {
    const client = new Client({ name: "understanding-integration", version: "1.0" }); t.after(() => client.close());
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.NODE_TEST_CONTEXT;
    await client.connect(new StdioClientTransport({ command: process.execPath, env, args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--workspace", fixture.root], stderr: "pipe" }));
    return client;
  };
  const call = async (client: Client, name: string, input: Record<string, unknown>) => ToolResultSchema.parse((await client.callTool({ name, arguments: input })).structuredContent);
  const client = await connect();
  assert.equal((await call(client, "project_scan", { project: fixture.path })).outcome, "ok");
  const context = (await call(client, "project_context", { project: fixture.path, paths: ["src/service.js"] })).data as any;
  const source = context.files.find((file: any) => file.path === "src/service.js"), text = await readFile(join(fixture.path, source.path), "utf8");
  const quote = text.split("\n").find((line) => line.trim().length > 3)!;
  assert.equal((await call(client, "project_model_record", { project: fixture.path, scan_id: context.scan_id, id: "service-observation", expected_revision: 0,
    module: "src", title: "Service observation", scope: ["src"], summary: "The service entry was read; no backend assumptions.", entities: [], flows: [], rules: [],
    related_paths: [source.path], sources: [{ path: source.path, sha256: source.sha256, line: text.split("\n").indexOf(quote) + 1, quote }], questions: ["Verify behavior in a real task"] })).outcome, "ok");
  await client.close(); const restarted = await connect();
  const restored = (await call(restarted, "project_context", { project: fixture.path, paths: [source.path] })).data as any;
  assert.equal(restored.models[0].revision, 1); assert.equal(restored.models[0].effective, false);
  const outside = await call(restarted, "project_scan", { project: "/tmp" }); assert.equal(outside.outcome, "error");
});
