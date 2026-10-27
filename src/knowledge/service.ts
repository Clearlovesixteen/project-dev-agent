import { feedbackContext } from "../feedback/service.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import { IdSchema, RelativePathSchema, TextSchema } from "../domain/common.js";
import { KnowledgeSchema } from "../domain/knowledge.js";
import { ToolResultSchema, type ToolResult } from "../domain/result.js";
import {
  assertBaseline,
  assertStateIgnored,
  type WorktreeBinding,
} from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { TaskStore } from "../storage/task-store.js";
import { renderKnowledge } from "./document.js";
import { searchKnowledge } from "./search.js";
import { KnowledgeSearchInputSchema } from "./search.js";
import { searchHistoryHints } from "../history/search.js";
import { projectContext } from "../understanding/context.js";
import { loadConfig, matchesPath } from "./config.js";

export const ExperienceProposeInputSchema = z
  .object({
    task_id: IdSchema,
    correction_id: IdSchema,
    title: TextSchema,
    type: z.enum(["code_convention", "business_rule", "change_relation"]),
    modules: z.array(TextSchema).max(50),
    paths: z.array(RelativePathSchema).max(100),
    applicable_conditions: z.array(TextSchema).max(50),
    rule: TextSchema,
    review_questions: z.array(TextSchema).min(1).max(30),
  })
  .strict();

/** 汇总可用规则与待核实线索，并从任务中的具体纠正生成本地经验候选。 */
export class KnowledgeService {
  private readonly files: ProjectFiles;
  constructor(private readonly binding: WorktreeBinding) {
    this.files = new ProjectFiles(binding.root);
  }

  private async execute(
    action: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      return ToolResultSchema.parse(await action());
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof z.ZodError
          ? "INVALID_INPUT"
          : "KNOWLEDGE_FAILED";
      return {
        outcome: "error",
        code,
        diagnostics: [
          {
            code,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** 以共享知识查询为基础附加历史和模块理解，各类候选保留自己的状态与来源。 */
  async search(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = KnowledgeSearchInputSchema.parse(input);
      const result = await searchKnowledge(this.files, request);
      // 主查询拒绝的路径不能借附加历史或模块查询重新进入结果。
      if (result.code === "PATHS_EXCLUDED") return result;
      const { config } = await loadConfig(this.files);
      const paths = request.paths.filter(
        (path) =>
          !config.exclude_paths.some((pattern) => matchesPath(pattern, path)),
      );
      // 附加线索不可用时暴露其状态或诊断，尽量保留已取得的知识查询结果。
      let understanding: unknown;
      try {
        understanding = await projectContext(this.files, {
          query: request.query,
          paths: paths.slice(0, 30),
          modules: request.modules.slice(0, 20),
          limit: Math.min(request.limit, 5),
        });
      } catch (error) {
        understanding = {
          state: "unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        return {
          ...result,
          data: {
            ...(result.data as object),
            feedback: await feedbackContext(this.files, request.query, paths),
            history: await searchHistoryHints(
              this.files,
              request.query,
              paths,
              request.limit,
            ),
            understanding,
          },
        };
      } catch (error) {
        return {
          ...result,
          outcome: "incomplete",
          data: {
            ...(result.data as object),
            understanding,
            history: {
              state: "unavailable",
              hints: [],
              message: error instanceof Error ? error.message : String(error),
            },
          },
          diagnostics: [
            ...result.diagnostics,
            {
              code: "HISTORY_HINTS_UNAVAILABLE",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });
  }

  /** 提案必须关联已有纠正记录，以复用真实原因和来源；这里只写本地 candidate 草稿。 */
  async propose(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = ExperienceProposeInputSchema.parse(input);
      const task = await new TaskStore(this.binding.root).load(request.task_id);
      if (task.repo_identity !== this.binding.repo_identity)
        throw new AppError("TASK_BINDING_MISMATCH", "该任务属于其他仓库");
      if (task.phase === "active") await assertBaseline(this.binding, task);
      const correction = task.corrections.find(
        (entry) => entry.id === request.correction_id,
      );
      if (!correction)
        throw new AppError(
          "CORRECTION_NOT_FOUND",
          "提炼可复用经验前，请先在任务中记录具体纠正内容",
        );
      await assertStateIgnored(this.binding);
      const id = `exp-${randomUUID()}`;
      const knowledge = KnowledgeSchema.parse({
        schema_version: 1,
        id,
        title: request.title,
        type: request.type,
        status: "candidate",
        modules: request.modules,
        paths: request.paths,
        applicable_conditions: request.applicable_conditions,
        rule: request.rule,
        rationale: correction.rationale,
        review_questions: request.review_questions,
        sources: [
          ...correction.sources,
          {
            kind: "experience",
            reference: `task:${task.id}#${correction.id}`,
            description: correction.description,
          },
        ],
      });
      const file = `.project-dev/local/proposals/${id}.md`;
      await this.files.create(file, renderKnowledge(knowledge));
      return {
        outcome: "ok",
        code: "EXPERIENCE_PROPOSED",
        data: {
          file,
          knowledge,
          next_step:
            "请与同事核对适用范围、规则、来源和待确认问题。只有明确的本地知识审查或团队 Git 审查，才能将草稿提升为已确认规则。MCP 服务不提供确认工具。",
        },
        diagnostics: [],
      };
    });
  }
}
