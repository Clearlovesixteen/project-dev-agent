import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { TaskSchema } from "../src/domain/task.js";
import { VERSION } from "../src/version.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../plugins/project-dev-agent/", import.meta.url));

test("release inventory matches bundled assets and carries no external dependency installation", async () => {
  const info = JSON.parse(await readFile(join(packageRoot, "build-info.json"), "utf8")) as { version: string; files: { path: string; sha256: string }[] };
  assert.equal(info.version, VERSION);
  for (const file of info.files) {
    assert.ok(!file.path.includes("node_modules") && !file.path.includes(".project-dev/local"));
    assert.equal(createHash("sha256").update(await readFile(join(packageRoot, file.path))).digest("hex"), file.sha256, file.path);
  }
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  // 安装者使用预构建插件，不能继承维护者安装完整依赖时的 Node 版本门槛。
  assert.equal(pkg.engines.node, ">=18.19.0");
  assert.equal(JSON.parse(await readFile(join(packageRoot, "build-info.json"), "utf8")).node, pkg.engines.node);
  const mcp = JSON.parse(await readFile(join(packageRoot, "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.project_dev.args, ["${PLUGIN_ROOT}/runtime/cli.mjs", "serve", "--plugin"]);
});

test("standalone plugin runs without source or node_modules and preserves task/configuration across relocation", { timeout: 30_000 }, async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const installed = join(fixture.root, "plugin v1"); await cp(packageRoot, installed, { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home };
  const doctor = JSON.parse((await execute(process.execPath, [join(installed, "runtime/cli.mjs"), "doctor"], { cwd: home, env })).stdout);
  assert.equal(doctor.version, VERSION);
  assert.equal(doctor.mcp_sdk_initialization, "ok");
  const sample = JSON.parse((await execute(process.execPath, [join(installed, "runtime/cli.mjs"), "sample", "create", "--destination", join(fixture.root, "bundled sample")], { cwd: home, env })).stdout);
  assert.equal(sample.outcome, "ok");
  async function connect(root: string) {
    const client = new Client({ name: "plugin-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [join(root, "runtime/cli.mjs"), "serve", "--plugin"], env, stderr: "pipe" });
    t.after(() => client.close());
    await client.connect(transport); return client;
  }
  const first = await connect(installed);
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    ToolResultSchema.parse((await client.callTool({ name, arguments: args })).structuredContent);
  const tools = (await first.listTools()).tools;
  assert.equal(tools.length, 14);
  assert.ok(tools.every((tool) => /[\u3400-\u9fff]/.test(tool.description ?? "")));
  assert.ok(tools.find((tool) => tool.name === "project_prepare")?.inputSchema.required?.includes("project"));
  const preview = await call(first, "project_prepare", { project: fixture.path });
  assert.equal((preview.data as { plugin_setup: { action: string } }).plugin_setup.action, "would_initialize");
  assert.equal(((await call(first, "plugin_status")).data as { configured: boolean }).configured, false);
  const unconfigured = await call(first, "task_check", { project: fixture.path });
  assert.equal(unconfigured.code, "PLUGIN_NOT_CONFIGURED");
  assert.ok(unconfigured.diagnostics.every((item) => /[\u3400-\u9fff]/.test(item.message)));
  assert.equal((await call(first, "plugin_status")).code, "PLUGIN_STATUS");
  const prepared = await call(first, "project_prepare", { project: fixture.path, apply: true });
  assert.equal((prepared.data as { plugin_setup: { action: string } }).plugin_setup.action, "initialized");
  const savedSettings = await readFile(join(home, "project-dev-agent/settings.json"), "utf8");

  // 在独立发布产物中走真实 MCP 链路，兼容测试不能只验证 doctor 或启动成功。
  assert.equal((await call(first, "project_scan", { project: fixture.path })).outcome, "ok");
  const context = (await call(first, "project_context", { project: fixture.path, paths: ["src/service.js"] })).data as {
    scan_id: string; files: { path: string; sha256: string }[];
  };
  const source = context.files.find((file) => file.path === "src/service.js")!;
  const lines = (await readFile(join(fixture.path, source.path), "utf8")).split("\n");
  const line = lines.findIndex((value) => value.trim().length > 3);
  assert.equal((await call(first, "project_model_record", {
    project: fixture.path, scan_id: context.scan_id, id: "runtime-service", expected_revision: 0,
    module: "src", title: "服务入口", scope: ["src"], summary: "记录已阅读的服务入口，供后续核对。",
    entities: [], flows: [], rules: [], related_paths: [source.path],
    sources: [{ path: source.path, sha256: source.sha256, line: line + 1, quote: lines[line] }],
    questions: ["具体业务规则由开发任务继续核对"],
  })).outcome, "ok");
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions/runtime.jsonl"), [
    { type: "session_meta", payload: { id: "runtime", cwd: fixture.path, source: "vscode" } },
    { type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "表单优先复用项目封装" }] } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  assert.equal((await call(first, "history_scan", { project: fixture.path })).outcome, "ok");
  const next = (await call(first, "history_next", { project: fixture.path })).data as {
    scan_id: string; batch: { id: string; messages: { id: string }[] };
  };
  assert.equal((await call(first, "history_record", {
    project: fixture.path, scan_id: next.scan_id, batch_id: next.batch.id,
    findings: [{ topic: "forms", title: "表单封装", type: "code_convention", audience: "project",
      rule: "表单优先复用项目封装", rationale: "用户明确表达", paths: [], applicable_conditions: ["当前项目表单"],
      signal: "explicit_preference", evidence: [{ message_id: next.batch.messages[0]!.id, quote: "表单优先复用项目封装" }],
      review_questions: ["核实封装的适用范围"] }], note: "已处理本批次",
  })).outcome, "ok");
  assert.equal((await call(first, "project_prepare", { project: "/outside-workspace" })).code, "PROJECT_OUTSIDE_WORKSPACE");
  const opened = await call(first, "task_open", { project: fixture.path, requirement: "Check plugin upgrade persistence",
    acceptance_criteria: [{ id: "persist", description: "Keep the same active task after restart" }] });
  const task = TaskSchema.parse(opened.data);
  await first.close();
  const secondPath = join(fixture.root, "plugin v2"); await cp(installed, secondPath, { recursive: true });
  const second = await connect(secondPath);
  assert.equal(((await call(second, "plugin_status")).data as { configured: boolean }).configured, true);
  await call(second, "project_prepare", { project: fixture.path, apply: true });
  assert.equal(await readFile(join(home, "project-dev-agent/settings.json"), "utf8"), savedSettings);
  const restored = (await call(second, "project_context", { project: fixture.path, paths: [source.path] })).data as {
    models: { id: string; revision: number; effective: boolean }[];
  };
  assert.equal(restored.models[0]?.id, "runtime-service");
  assert.equal(restored.models[0]?.revision, 1);
  assert.equal(restored.models[0]?.effective, false);
  const knowledge = (await call(second, "knowledge_search", { project: fixture.path, query: "表单" })).data as {
    history: { hints: { effective: boolean }[] };
  };
  assert.equal(knowledge.history.hints.length, 1);
  assert.equal(knowledge.history.hints[0]?.effective, false);
  assert.equal(((await call(second, "history_next", { project: fixture.path })).data as { batch: unknown }).batch, null);
  const checked = await call(second, "task_check", { project: fixture.path });
  assert.equal(TaskSchema.parse((checked.data as { recorded_task: unknown }).recorded_task).id, task.id);
});
