import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import { IdSchema, RelativePathSchema, TextSchema } from "../domain/common.js";
import { KnowledgeSchema } from "../domain/knowledge.js";
import { ToolResultSchema, type ToolResult } from "../domain/result.js";
import { assertBaseline, assertStateIgnored, type WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { TaskStore } from "../storage/task-store.js";
import { renderKnowledge } from "./document.js";
import { searchKnowledge } from "./search.js";
import { KnowledgeSearchInputSchema } from "./search.js";
import { searchHistoryHints } from "../history/search.js";
import { projectContext } from "../understanding/context.js";
import { loadConfig, matchesPath } from "./config.js";

export const ExperienceProposeInputSchema = z.object({
  task_id: IdSchema,
  correction_id: IdSchema,
  title: TextSchema,
  type: z.enum(["code_convention", "business_rule", "change_relation"]),
  modules: z.array(TextSchema).max(50),
  paths: z.array(RelativePathSchema).max(100),
  applicable_conditions: z.array(TextSchema).max(50),
  rule: TextSchema,
  review_questions: z.array(TextSchema).min(1).max(30),
}).strict();

export class KnowledgeService {
  private readonly files: ProjectFiles;
  constructor(private readonly binding: WorktreeBinding) { this.files = new ProjectFiles(binding.root); }

  private async execute(action: () => Promise<ToolResult>): Promise<ToolResult> {
    try { return ToolResultSchema.parse(await action()); } catch (error) {
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "KNOWLEDGE_FAILED";
      return { outcome: "error", code, diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] };
    }
  }

  async search(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = KnowledgeSearchInputSchema.parse(input);
      const result = await searchKnowledge(this.files, request);
      if (result.code === "PATHS_EXCLUDED") return result;
      const { config } = await loadConfig(this.files);
      const paths = request.paths.filter((path) => !config.exclude_paths.some((pattern) => matchesPath(pattern, path)));
      let understanding: unknown;
      try { understanding = await projectContext(this.files, { query: request.query, paths: paths.slice(0, 30), modules: request.modules.slice(0, 20), limit: Math.min(request.limit, 5) }); }
      catch (error) { understanding = { state: "unavailable", message: error instanceof Error ? error.message : String(error) }; }
      try {
        return { ...result, data: { ...(result.data as object), history: await searchHistoryHints(this.files, request.query, paths, request.limit), understanding } };
      } catch (error) {
        return { ...result, outcome: "incomplete", diagnostics: [...result.diagnostics,
          { code: "HISTORY_HINTS_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }

  async propose(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = ExperienceProposeInputSchema.parse(input);
      const task = await new TaskStore(this.binding.root).load(request.task_id);
      if (task.repo_identity !== this.binding.repo_identity) throw new AppError("TASK_BINDING_MISMATCH", "Task belongs to a different repository");
      if (task.phase === "active") await assertBaseline(this.binding, task);
      const correction = task.corrections.find((entry) => entry.id === request.correction_id);
      if (!correction) throw new AppError("CORRECTION_NOT_FOUND", "Record the specific correction on this task before proposing reusable experience");
      await assertStateIgnored(this.binding);
      const id = `exp-${randomUUID()}`;
      const knowledge = KnowledgeSchema.parse({ schema_version: 1, id, title: request.title, type: request.type, status: "candidate",
        modules: request.modules, paths: request.paths, applicable_conditions: request.applicable_conditions, rule: request.rule,
        rationale: correction.rationale, review_questions: request.review_questions,
        sources: [...correction.sources, { kind: "experience", reference: `task:${task.id}#${correction.id}`, description: correction.description }] });
      const file = `.project-dev/local/proposals/${id}.md`;
      await this.files.create(file, renderKnowledge(knowledge));
      return { outcome: "ok", code: "EXPERIENCE_PROPOSED", data: { file, knowledge,
        next_step: "Review scope, rule, sources and questions with a colleague. Only explicit local knowledge review or the team's Git review should promote this draft. The MCP server has no confirmation tool." }, diagnostics: [] };
    });
  }
}
