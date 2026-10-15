import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
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
  const checked = await call(second, "task_check", { project: fixture.path });
  assert.equal(TaskSchema.parse((checked.data as { recorded_task: unknown }).recorded_task).id, task.id);
});
