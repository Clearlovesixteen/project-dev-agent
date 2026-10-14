import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("STDIO history tools expose pending analysis, persist a quoted habit and return it through knowledge search", { timeout: 20_000 }, async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "test-codex"); await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions/one.jsonl"), [
    { type: "session_meta", payload: { id: "one", cwd: fixture.path, source: "vscode" } },
    { type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "表单优先复用项目封装" }] } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  const client = new Client({ name: "history-integration", version: "1.0.0" });
  t.after(() => client.close());
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.CODEX_HOME = home; delete env.NODE_TEST_CONTEXT;
  await client.connect(new StdioClientTransport({ command: process.execPath, env,
    args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--project", fixture.path], stderr: "pipe" }));
  const call = async (name: string, input: Record<string, unknown>) => ToolResultSchema.parse((await client.callTool({ name, arguments: input })).structuredContent);
  assert.equal((await call("history_scan", {})).outcome, "ok");
  const next = (await call("history_next", {})).data as { scan_id: string; batch: { id: string; messages: { id: string }[] } };
  assert.equal((await call("history_record", { scan_id: next.scan_id, batch_id: next.batch.id,
    findings: [{ topic: "forms", title: "项目表单封装", type: "code_convention", audience: "project", rule: "表单优先复用项目封装",
      rationale: "用户明确表达", paths: [], applicable_conditions: ["当前项目表单"], signal: "explicit_preference",
      evidence: [{ message_id: next.batch.messages[0]!.id, quote: "表单优先复用项目封装" }], review_questions: ["核实封装的适用范围"] }],
    note: "已阅读全部对话并保留明确偏好" })).outcome, "ok");
  assert.equal(((await call("history_next", {})).data as { batch: unknown }).batch, null);
  const searched = (await call("knowledge_search", { query: "表单" })).data as { history: { hints: { effective: boolean }[] } };
  assert.equal(searched.history.hints.length, 1); assert.equal(searched.history.hints[0]!.effective, false);
});
