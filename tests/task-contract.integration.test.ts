import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { TaskSchema } from "../src/domain/task.js";
import { digest } from "../src/knowledge/document.js";
import { runtimeReceipt } from "../src/runtime/version-receipt.js";
import { VERSION } from "../src/version.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

// 重放旧引用、修正、原样重试及源码变化，覆盖 SDK 的发现、校验、持久化与回执。
test("任务 MCP 汇总旧格式错误，精简引用绑定真实原文，纠正后可继续", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const client = new Client({ name: "contract-regression", version: "1" }); t.after(() => client.close());
  const script = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, "serve", "--project", fixture.path],
    env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH ?? "" }, stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  for (const name of ["task_open", "task_update"]) {
    const schema = tools.find(tool => tool.name === name)!.inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties!.implementation_basis);
    assert.ok(schema.required?.includes(name === "task_open" ? "requirement" : "expected_revision"));
  }
  const call = async (name: string, args: Record<string, unknown>) => ToolResultSchema.parse(
    (await client.callTool({ name, arguments: args })).structuredContent);
  const open = { requirement: "按仓库惯例复用已有服务", acceptance_criteria: [{ id: "access", description: "沿用锁定的行为" }] };
  const legacy = { references: [{ path: "/outside", reason: "private legacy string" }], decisions: [{ id: "d", decision: "旧格式" }] };
  const failed = await call("task_open", { ...open, implementation_basis: legacy });
  assert.equal(failed.code, "TASK_INPUT_INVALID");
  assert.equal(failed.diagnostics.length, 1);
  assert.match(failed.diagnostics[0]!.message, /quote/);
  assert.doesNotMatch(JSON.stringify(failed), /private legacy string/);
  assert.equal((await call("task_open", { implementation_basis: legacy, ...open })).code, "TASK_INPUT_RETRY_STOPPED");
  assert.equal((await call("task_check", {})).code, "NO_ACTIVE_TASK");

  const path = "AGENTS.md", text = await readFile(join(fixture.path, path), "utf8");
  const lines = text.split(/\r?\n/), index = lines.findIndex(line => line.trim() && lines.filter(item => item.includes(line.trim())).length === 1);
  assert.ok(index >= 0);
  const ref = { id: "convention", path, quote: lines[index]!.trim() };
  const decisions = [{ id: "d", constraint: "项目约束", implementation: "复用既有结构", acceptance_id: "access", reference_ids: [ref.id] }];
  const opened = TaskSchema.parse((await call("task_open", { ...open, implementation_basis: { references: [ref], decisions } })).data);
  assert.deepEqual(opened.implementation_bases![0]!.basis.references[0], { ...ref, line: index + 1, sha256: digest(text) });
  const update = { task_id: opened.id, expected_revision: opened.revision };
  assert.equal((await call("task_update", { ...update, implementation_basis: legacy })).code, "TASK_INPUT_INVALID");
  assert.equal((await call("task_update", { ...update, implementation_basis: legacy })).code, "TASK_INPUT_RETRY_STOPPED");
  assert.equal((await call("task_update", { ...update, surprise: true })).code, "TASK_INPUT_INVALID");
  const fixed = { references: [{ ...ref, line: index + 1 }], decisions };
  assert.equal((await call("task_update", { ...update, implementation_basis: { ...fixed, references: [{ ...ref, sha256: "0".repeat(64) }] } })).code,
    "IMPLEMENTATION_REFERENCE_INVALID");
  await writeFile(join(fixture.path, path), text + "\n" + ref.quote + "\n");
  const request = { ...update, implementation_basis: { references: [ref], decisions }, response_view: "compact" };
  assert.equal((await call("task_update", request)).code, "IMPLEMENTATION_REFERENCE_INVALID");
  const retry = await call("task_update", request);
  assert.equal(retry.code, "IMPLEMENTATION_REFERENCE_INVALID");
  assert.equal((retry.data as { retry_same_input: boolean }).retry_same_input, false);
  assert.match((retry.data as { required_action: string }).required_action, /核实引用原文/);
  // 参数完全相同，仅修复当前源码。失败结果不能被缓存到下一次任务检查。
  await writeFile(join(fixture.path, path), text);
  const compact = await client.callTool({ name: "task_update", arguments: request });
  assert.equal(ToolResultSchema.parse(compact.structuredContent).outcome, "ok");
  assert.deepEqual(JSON.parse((compact.content as { text: string }[])[0]!.text), compact.structuredContent);
  assert.ok(!JSON.stringify(compact.structuredContent).includes(ref.quote));
});

// 启动以后包可能被替换或清理；目录内的清单不能冒充正在运行的进程身份。
test("版本回执识别原位替换、独立安装预期和旧目录移除", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const root = join(await realpath(fixture.root), "installed"); await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "project-dev-agent", version: VERSION }));
  assert.equal((await runtimeReceipt(root)).state, "matched");
  assert.equal((await runtimeReceipt(root, VERSION + "-other")).state, "reload_required");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "project-dev-agent", version: VERSION + "-other" }));
  const receipt = await runtimeReceipt(root);
  assert.equal(receipt.state, "reload_required"); assert.equal(receipt.loaded_version, VERSION);
  assert.equal((await runtimeReceipt(join(root, "removed"))).state, "reload_required");
  assert.equal((await runtimeReceipt(undefined)).state, "unverified");
});
