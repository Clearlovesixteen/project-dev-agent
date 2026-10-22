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

test("新版模型通过真实 MCP 创建、按规则读取、局部修订并跨进程恢复", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const connect = async () => {
    const client = new Client({ name: "business-model-integration", version: "1" }); t.after(() => client.close());
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.NODE_TEST_CONTEXT;
    await client.connect(new StdioClientTransport({ command: process.execPath, env,
      args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--workspace", fixture.root], stderr: "pipe" }));
    return client;
  };
  const call = async (client: Client, name: string, input: object) => {
    const result = await client.callTool({ name, arguments: { project: fixture.path, ...input } });
    assert.ok(result.structuredContent, JSON.stringify(result));
    return ToolResultSchema.parse(result.structuredContent);
  };
  const first = await connect();
  const opened = await call(first, "task_open", { requirement: "协议夹具：核对服务入口", acceptance_criteria: [{ id: "initial", description: "服务入口保持正确" }],
    evaluation: { case_id: "mcp-fixture", variant: "assisted", sample: "fixture" } });
  const task = opened.data as any; assert.equal(opened.outcome, "ok");
  const available = (await first.listTools()).tools;
  assert.ok(available.find((tool) => tool.name === "project_model_record")?.inputSchema.properties?.patch);
  assert.ok(available.find((tool) => tool.name === "project_context")?.inputSchema.properties?.rule_ids);
  assert.ok(available.find((tool) => tool.name === "task_check")?.inputSchema.properties?.include_evaluation);
  await call(first, "project_scan", {});
  const context = (await call(first, "project_context", { paths: ["src/service.js"] })).data as any;
  const source = context.files.find((item: any) => item.path === "src/service.js");
  const lines = (await readFile(join(fixture.path, source.path), "utf8")).split("\n"), index = lines.findIndex((line) => line.trim().length > 3);
  const rule = { id: "service", description: "服务入口按当前实现提供业务能力", responsibility: "unknown", basis: "observed", conditions: ["调用该服务时"], exceptions: ["具体异常分支需要进一步核对"], source_ids: ["service-code"], assertion: { subject: "服务入口", property: "提供能力", value: "true" } };
  const created = await call(first, "project_model_record", { id: "business-service", schema_version: 2, expected_revision: 0, scan_id: context.scan_id,
    revision_reason: "记录已阅读入口，保留未知语义", module: "src", title: "服务入口观察", scope: [source.path], summary: "只记录可核对的入口线索。",
    entities: [], flows: [], rules: [rule], relations: [], questions: ["完整业务条件待任务核对"], related_paths: [source.path],
    sources: [{ id: "service-code", kind: "code", path: source.path, sha256: source.sha256, line: index + 1, quote: lines[index] }] });
  assert.equal(created.outcome, "ok", JSON.stringify(created));
  assert.equal((await call(first, "task_update", { task_id: task.id, expected_revision: 0, change_items: [{ id: "service-check", target_path: source.path, action: "verify", requirement: "协议夹具", rationale: "核对入口", sources: [{ kind: "code", reference: source.path }] }] })).outcome, "ok");
  const quality = (await call(first, "task_check", { include_evaluation: true })).data as any;
  assert.equal(quality.quality.business_checks.total, 3); assert.equal(quality.evaluation.fixture_tasks, 1);
  const preview = (await call(first, "project_context", { paths: [source.path] })).data as any;
  assert.equal(preview.models[0].content_truncated, true); assert.equal(preview.models[0].sources, undefined);
  const updated = await call(first, "project_model_record", { id: "business-service", schema_version: 2, expected_revision: 1, scan_id: context.scan_id,
    revision_reason: "补充入口适用条件", patch: { upsert_rules: [{ ...rule, conditions: ["当前模块调用入口时"] }] } });
  assert.equal(updated.outcome, "ok", JSON.stringify(updated));
  await first.close();
  const second = await connect();
  const detail = (await call(second, "project_context", { model_id: "business-service", model_revision: 2, rule_ids: ["service"] })).data as any;
  assert.equal(detail.models[0].rules[0].freshness, "current");
  assert.deepEqual(detail.models[0].rules[0].conditions, ["当前模块调用入口时"]);
  assert.deepEqual(detail.models[0].rules[0].exceptions, rule.exceptions);
  assert.deepEqual(detail.models[0].rules[0].assertion, rule.assertion);
  const qualityAgain = (await call(second, "task_check", { include_evaluation: true })).data as any;
  assert.equal(qualityAgain.quality.state, "advisory"); assert.equal(qualityAgain.evaluation.fixture_tasks, 1);
  assert.equal(detail.models[0].sources[0].sha256, source.sha256);
});
