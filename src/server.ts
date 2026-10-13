import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";
import { AppError } from "./domain/error.js";
import { VERSION } from "./version.js";
import { Workspace } from "./workspace.js";
import { prepareProject, ProjectPrepareInputSchema } from "./personal-setup.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolResult } from "./domain/result.js";
import { bindWorktree, type WorktreeBinding } from "./git/index.js";
import { TaskService } from "./task-service.js";
import { TaskCheckInputSchema, TaskOpenInputSchema, TaskUpdateInputSchema } from "./tools/inputs.js";
import { KnowledgeService, ExperienceProposeInputSchema } from "./knowledge/service.js";
import { KnowledgeSearchInputSchema } from "./knowledge/search.js";

function mcpResult(result: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result,
    isError: result.outcome === "error" };
}

export function createServer(bindingFor: (project?: string) => Promise<WorktreeBinding>, workspace?: string): McpServer {
  const projectField = z.string().min(1).max(4_096).describe("Absolute current Git worktree root");
  const scope = { project: workspace ? projectField : projectField.optional() };
  async function run(project: string | undefined, action: (binding: WorktreeBinding) => Promise<ToolResult>) {
    try { return mcpResult(await action(await bindingFor(project))); } catch (error) {
      const code = error instanceof AppError ? error.code : "PROJECT_OPERATION_FAILED";
      return mcpResult({ outcome: "error", code, diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] });
    }
  }
  const server = new McpServer({ name: "project-dev-agent", version: VERSION }, {
    instructions: (workspace ? `Workspace mode: every call must pass project as the absolute current Git root inside ${workspace}. Do not assume the parent workspace is a Git repository. ` : "") + "Track related code changes with an evidence-based checklist. Open a task before edits; record impact analysis, then review the diff and validation results. A changed path is not a completed review. This server does not independently establish business correctness.",
  });
  server.registerTool("project_prepare", {
    description: "Check project readiness and active task without writing by default. apply: true adds only a Git-local ignore for task state; preserves existing work and shared project files.",
    inputSchema: ProjectPrepareInputSchema.safeExtend(scope),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, ...input }) => run(project, (binding) => prepareProject(binding, input)));
  server.registerTool("task_open", {
    description: "Open a tracked development task in the bound, clean Git worktree; specify the request and acceptance criteria before editing.",
    inputSchema: TaskOpenInputSchema.safeExtend(scope),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ project, ...input }) => run(project, (binding) => new TaskService(binding).open(input)));
  server.registerTool("task_update", {
    description: "Save the complete updated collections of an existing task using its latest revision. Reviewed items need evidence. Preserve existing IDs. Set phase to aborted with a reason to stop a task.",
    inputSchema: TaskUpdateInputSchema.safeExtend(scope),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ project, ...input }) => run(project, (binding) => new TaskService(binding).update(input)));
  server.registerTool("task_check", {
    description: "Omit task_id to recover the current active task. Read a task and compare its recorded checklist with Git changes. Return pending acceptance, unexpected paths and review evidence; this does not automatically approve business logic.",
    inputSchema: TaskCheckInputSchema.safeExtend(scope),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, ...input }) => run(project, (binding) => new TaskService(binding).check(input)));
  server.registerTool("knowledge_search", {
    description: "Retrieve project rules scoped to modules, affected paths and keywords. Confirmed rules with current sources are effective; candidates and stale sources are review hints. Record applied rule IDs and versions on the task.",
    inputSchema: KnowledgeSearchInputSchema.safeExtend(scope),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, ...input }) => run(project, (binding) => new KnowledgeService(binding).search(input)));
  server.registerTool("experience_propose", {
    description: "Turn a recorded task correction into a scoped local candidate draft with source provenance and open review questions. Does not confirm knowledge or write shared rules.",
    inputSchema: ExperienceProposeInputSchema.safeExtend(scope),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ project, ...input }) => run(project, (binding) => new KnowledgeService(binding).propose(input)));
  return server;
}

export async function startServer(project: string): Promise<void> {
  const binding = await bindWorktree(project);
  const server = createServer(async (requested) => {
    if (requested && resolve(requested) !== binding.root) throw new AppError("PROJECT_BINDING_MISMATCH", "This server is bound to one different project");
    return binding;
  });
  await server.connect(new StdioServerTransport());
}

export async function startWorkspaceServer(path: string): Promise<void> {
  const workspace = await Workspace.open(path);
  await createServer((project) => workspace.bind(project), workspace.root).connect(new StdioServerTransport());
}
