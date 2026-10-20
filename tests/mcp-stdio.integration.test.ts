import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TaskSchema } from "../src/domain/task.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("real STDIO MCP client discovers the tools and completes open/update/check without confusing writer coverage with review", { timeout: 60_000 }, async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--project", fixture.path], stderr: "pipe" });
  const client = new Client({ name: "project-dev-integration", version: "0.1.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["experience_propose", "history_next", "history_record", "project_scan", "project_context", "project_model_record", "history_scan", "knowledge_search", "project_prepare", "task_check", "task_open", "task_update"].sort());
  const opened = await client.callTool({ name: "task_open", arguments: {
    requirement: "Add disabled account support", acceptance_criteria: [{ id: "access", description: "Disabled accounts lose access" }],
  } });
  const task = TaskSchema.parse(ToolResultSchema.parse(opened.structuredContent).data);
  const item = (id: string, path: string) => ({ id, target_path: path, action: "modify", requirement: `Update ${id}`,
    rationale: "Related account behavior", sources: [{ kind: "code", reference: path }], status: "pending" });
  const updated = await client.callTool({ name: "task_update", arguments: {
    task_id: task.id, expected_revision: 0,
    change_items: [item("writer", "src/service.js"), item("auth", "src/auth.js"), item("view", "src/view.js")],
  } });
  assert.equal(TaskSchema.parse(ToolResultSchema.parse(updated.structuredContent).data).revision, 1);
  const servicePath = join(fixture.path, "src/service.js");
  await writeFile(servicePath, (await readFile(servicePath, "utf8")).replace('new Set(["active"])', 'new Set(["active", "disabled"])'));
  const result = ToolResultSchema.parse((await client.callTool({ name: "task_check", arguments: { task_id: task.id } })).structuredContent);
  assert.equal(result.outcome, "incomplete");
  const data = result.data as { changed_paths: string[]; pending_items: string[]; recorded_task: unknown };
  assert.deepEqual(data.changed_paths, ["src/service.js"]);
  assert.deepEqual(data.pending_items, ["writer", "auth", "view"]);
  assert.equal(TaskSchema.parse(data.recorded_task).revision, 1);
  const completedItems = TaskSchema.parse(data.recorded_task).change_items.map((entry) => entry.id !== "writer" ? entry : {
    ...entry, status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "src/service.js", summary: "核对写入逻辑" }],
  });
  const complete = await client.callTool({ name: "task_update", arguments: { task_id: task.id, expected_revision: 1,
    review_snapshot: (result.data as any).review_snapshot, change_items: completedItems } });
  assert.equal(ToolResultSchema.parse(complete.structuredContent).outcome, "ok");
  await writeFile(servicePath, (await readFile(servicePath, "utf8")) + "\n// 后续调整\n");
  const stale = ToolResultSchema.parse((await client.callTool({ name: "task_check", arguments: {} })).structuredContent).data as any;
  assert.deepEqual(stale.stale_evidence.change_items, ["writer"]);
  const renewed = await client.callTool({ name: "task_update", arguments: { task_id: task.id, expected_revision: 2,
    review_snapshot: stale.review_snapshot, reviewed_ids: { change_items: ["writer"] }, change_items: completedItems } });
  assert.equal(ToolResultSchema.parse(renewed.structuredContent).outcome, "ok");
  const fresh = ToolResultSchema.parse((await client.callTool({ name: "task_check", arguments: {} })).structuredContent).data as any;
  assert.deepEqual(fresh.stale_evidence.change_items, []);
  const stopped = await client.callTool({ name: "task_update", arguments: { task_id: task.id, expected_revision: 3,
    phase: "aborted", abort_reason: "Integration test leaves the intentionally incomplete implementation unapproved" } });
  assert.equal(ToolResultSchema.parse(stopped.structuredContent).outcome, "ok");
});
