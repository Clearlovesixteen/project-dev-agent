import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const scope = { query: "表单", paths: ["src/form.ts"] };
  const feedback = await call("project_feedback_record", { id: "form-choice", rule: "表单复用已存在的封装", category: "code_convention",
    audience: "project", paths: ["src"], conditions: ["组件覆盖交互时"], source: { session_id: "one", quote: "表单优先复用项目封装" } });
  assert.equal(feedback.outcome, "ok");
  const searched = (await call("knowledge_search", scope)).data as any;
  const compact = async (input = scope) => ((await call("project_context", { view: "compact", ...input })).data as any).knowledge_context;
  const brief = await compact();
  assert.equal(brief.history.hints.length, 1);
  assert.equal(brief.history.hints[0].effective, false);
  assert.equal(brief.history.hints[0].id, searched.history.hints[0].id);
  assert.deepEqual(brief.history.hints[0].applicable_conditions, ["当前项目表单"]);
  assert.equal(brief.history.hints[0].evidence, undefined);
  assert.equal(brief.feedback.version, searched.feedback.version);
  assert.equal(brief.feedback.review_required, true);
  assert.deepEqual(brief.feedback.items[0].conditions, ["组件覆盖交互时"]);
  assert.equal(brief.feedback.items[0].source, undefined);
  assert.equal(brief.details_request, undefined);
  const mixed = await compact({ ...scope, paths: ["src/form.ts", "dist/secret.js"] });
  assert.equal(mixed.feedback.excluded_path_count, 1);
  assert.equal(mixed.feedback.version, null);
  const excluded = await compact({ ...scope, paths: ["dist/secret.js"] });
  assert.equal(excluded.state, "excluded");
  assert.deepEqual(excluded.history.hints, []);
  assert.equal(excluded.feedback.version, null);

  // 大项目超出预算时不打开批次。详情仍核验证据，历史损坏也应保留其他来源。
  const manifestPath = join(fixture.path, ".project-dev/local/history/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.batches.push(...["0", "1", "2", "3"].map(char => char.repeat(32)));
  await writeFile(manifestPath, JSON.stringify(manifest));
  const limited = await compact();
  assert.equal(limited.history.state, "lookup_required");
  assert.equal(limited.history.lookup_required, true);
  assert.equal(limited.details_request.tool, "knowledge_search");
  assert.equal(limited.feedback.version, searched.feedback.version);
  await writeFile(manifestPath, "{");
  const partial = await compact();
  assert.equal(partial.history.state, "unavailable");
  assert.equal(partial.feedback.version, searched.feedback.version);
  const corrupt = await call("knowledge_search", scope);
  assert.equal(corrupt.outcome, "incomplete");
  assert.equal((corrupt.data as any).feedback.version, searched.feedback.version);
});
