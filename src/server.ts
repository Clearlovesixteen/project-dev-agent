import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolResult } from "./domain/result.js";
import { bindWorktree } from "./git/index.js";
import { TaskService } from "./task-service.js";
import { TaskCheckInputSchema, TaskOpenInputSchema, TaskUpdateInputSchema } from "./tools/inputs.js";
import { KnowledgeService, ExperienceProposeInputSchema } from "./knowledge/service.js";
import { KnowledgeSearchInputSchema } from "./knowledge/search.js";

function mcpResult(result: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result,
    isError: result.outcome === "error" };
}

export function createServer(service: TaskService, knowledge: KnowledgeService): McpServer {
  const server = new McpServer({ name: "project-dev-agent", version: "0.1.0" }, {
    instructions: "Track related code changes with an evidence-based checklist. Open a task before edits; record impact analysis, then review the diff and validation results. A changed path is not a completed review. This server does not independently establish business correctness.",
  });
  server.registerTool("task_open", {
    description: "Open a tracked development task in the bound, clean Git worktree; specify the request and acceptance criteria before editing.",
    inputSchema: TaskOpenInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => mcpResult(await service.open(input)));
  server.registerTool("task_update", {
    description: "Save the complete updated collections of an existing task using its latest revision. Reviewed items need evidence. Preserve existing IDs. Set phase to aborted with a reason to stop a task.",
    inputSchema: TaskUpdateInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => mcpResult(await service.update(input)));
  server.registerTool("task_check", {
    description: "Read a task and compare its recorded checklist with Git changes. Return pending acceptance, unexpected paths and review evidence; this does not automatically approve business logic.",
    inputSchema: TaskCheckInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => mcpResult(await service.check(input)));
  server.registerTool("knowledge_search", {
    description: "Retrieve project rules scoped to modules, affected paths and keywords. Confirmed rules with current sources are effective; candidates and stale sources are review hints. Record applied rule IDs and versions on the task.",
    inputSchema: KnowledgeSearchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => mcpResult(await knowledge.search(input)));
  server.registerTool("experience_propose", {
    description: "Turn a recorded task correction into a scoped local candidate draft with source provenance and open review questions. Does not confirm knowledge or write shared rules.",
    inputSchema: ExperienceProposeInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => mcpResult(await knowledge.propose(input)));
  return server;
}

export async function startServer(project: string): Promise<void> {
  const binding = await bindWorktree(project);
  const server = createServer(new TaskService(binding), new KnowledgeService(binding));
  await server.connect(new StdioServerTransport());
}
