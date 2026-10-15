import { z } from "zod";
import { IdSchema, RelativePathSchema, SourceSchema, TextSchema } from "./common.js";

/** A reviewable piece of project knowledge, rather than an unscoped instruction. */
export const KnowledgeSchema = z.object({
  schema_version: z.literal(1),
  id: IdSchema,
  title: TextSchema,
  type: z.enum(["code_convention", "business_rule", "change_relation"]),
  status: z.enum(["candidate", "confirmed", "needs_review", "disabled"]),
  modules: z.array(TextSchema).max(50),
  paths: z.array(RelativePathSchema).max(100),
  applicable_conditions: z.array(TextSchema).max(50),
  rule: TextSchema,
  rationale: TextSchema,
  sources: z.array(SourceSchema).min(1, "知识必须保留至少一项来源").max(30),
  review_questions: z.array(TextSchema).max(30).default([]),
  confirmed_by: TextSchema.optional(),
  reviewed_at: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((knowledge, context) => {
  if (knowledge.modules.length === 0 && knowledge.paths.length === 0
    && knowledge.applicable_conditions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["applicable_conditions"],
      message: "请通过模块、路径或适用条件明确作用范围",
    });
  }

  if (knowledge.status === "confirmed" || knowledge.status === "needs_review") {
    if (knowledge.confirmed_by === undefined) {
      context.addIssue({
        code: "custom",
        path: ["confirmed_by"],
        message: "已审查的知识必须注明确认人",
      });
    }
    if (knowledge.reviewed_at === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reviewed_at"],
        message: "已审查的知识必须保留审查时间",
      });
    }
  }
  if (knowledge.status === "confirmed" && knowledge.review_questions.length > 0) {
    context.addIssue({ code: "custom", path: ["review_questions"], message: "确认知识前，请先解决待审查问题" });
  }
});

export type Knowledge = z.infer<typeof KnowledgeSchema>;
