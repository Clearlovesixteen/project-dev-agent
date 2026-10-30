import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { DiagnosticWriter, observeTool } from "../src/observability/writer.js";
import { ToolResultSchema } from "../src/domain/result.js";

const bundle = fileURLToPath(new URL("../../plugins/project-dev-agent/runtime/cli.mjs", import.meta.url));
test("真实 STDIO 保留原 16 工具，新增输入、运行设置和回执贯通，错误会话不能更新任务", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex-home"); await mkdir(home);
  const env = Object.fromEntries(Object.entries({ ...process.env, CODEX_HOME: home }).filter((item): item is [string, string] => item[1] !== undefined));
  const client = new Client({ name: "pda-auto-integration", version: "1" }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, "serve", "--plugin"], env, stderr: "pipe" }));
  assert.equal((await client.listTools()).tools.length, 16);
  const call = async (name: string, args: Record<string, unknown> = {}) => ToolResultSchema.parse((await client.callTool({ name, arguments: args })).structuredContent);
  assert.equal((await call("project_prepare", { project: fixture.path, apply: true })).outcome, "ok");
  const status = (await call("plugin_status")).data as { revision: string; runtime: { revision: string | null; diagnostics: { upload: boolean } } };
  assert.equal(status.runtime.diagnostics.upload, true, "新安装在真实 MCP 启动阶段已配置默认上报");
  const configured = await call("plugin_configure", { workspace: fixture.path, expected_revision: status.revision, apply: true,
    runtime: { mode: "auto", expected_revision: status.runtime.revision } });
  assert.equal(configured.outcome, "ok");
  const interaction = { session_id: "native-session-a", turn_id: "turn-a", operation_id: randomUUID() };
  assert.equal((await call("project_scan", { project: fixture.path, interaction })).outcome, "ok");
  const context = await call("project_context", { project: fixture.path, query: "account 状态", interaction });
  assert.notEqual(context.outcome, "error");
  const receipt = (context.data as { context_id: string }).context_id;
  const input = { project: fixture.path, requirement: "原始私有 SDD 文本不能进入诊断", acceptance_criteria: [{ id: "behavior", description: "符合已给的业务要求" }],
    spec_input: { kind: "sdd", source_ids: ["task-request"] }, interaction: { ...interaction, context_id: receipt } };
  const opened = await call("task_open", input); assert.equal(opened.outcome, "ok", JSON.stringify(opened));
  const task = opened.data as { id: string; revision: number };
  assert.equal((await call("task_open", input)).code, "TASK_REUSED");
  assert.equal((await call("task_update", { project: fixture.path, task_id: task.id, expected_revision: 0, phase: "aborted", abort_reason: "跨会话不能中止",
    interaction: { session_id: "other" } })).code, "TASK_SESSION_MISMATCH");
  const events = (await new DiagnosticWriter(home).read()).events;
  assert.ok(events.some(event => event.event_name === "context.acknowledged" && event.reason_code === "RECEIPT_MATCHED"));
  assert.ok(events.some(event => event.event_name === "workflow.bound" && event.attributes.input_kind === "sdd"));
  assert.equal(events.filter(event => event.event_name === "workflow.bound").length, 1);
  assert.ok(!JSON.stringify(events).includes(input.requirement)); assert.ok(!JSON.stringify(events).includes(fixture.path));
  await writeFile(join(home, "project-dev-agent/runtime.json"), "damaged");
  const safeStatus = await call("plugin_status"); assert.equal(safeStatus.outcome, "ok");
  assert.equal((safeStatus.data as { runtime: { fallback_mode: string } }).runtime.fallback_mode, "manual");
});

test("诊断实现挂起也有预算，不延迟正常业务完成或改变原始错误", async () => {
  const writer = { record: () => new Promise<boolean>(() => {}) } as unknown as DiagnosticWriter;
  const started = performance.now();
  assert.equal(await observeTool(writer, "project_context", undefined, async () => 42), 42);
  assert.ok(performance.now() - started < 600);
  const failure = new Error("原始业务错误");
  await assert.rejects(observeTool(writer, "task_open", undefined, async () => { throw failure; }), error => error === failure);
});
