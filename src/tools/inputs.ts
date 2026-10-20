import { z } from "zod";
import { IdSchema, ReviewSnapshotSchema, TextSchema } from "../domain/common.js";
import { AcceptanceCriterionSchema, ChangeItemSchema, CorrectionSchema, ValidationRecordSchema } from "../domain/task.js";

// 工具只接收业务输入；任务 ID、Git 基线、时间和初始状态由服务生成，不能由调用方伪造。
export const TaskOpenInputSchema = z.object({
  requirement: TextSchema,
  acceptance_criteria: z.array(z.object({ id: IdSchema, description: TextSchema }).strict()).min(1).max(100),
}).strict();

// 集合字段省略表示保留，传入则完整替换；服务层另行检查旧 ID 不丢失和预期修订号。
// strict 拒绝未声明字段，防止把拼错的参数静默忽略为一次“成功更新”。
const ReviewedIds = (maximum: number) => z.array(IdSchema).max(maximum)
  .refine((ids) => new Set(ids).size === ids.length, "本次复核的条目 ID 不能重复").default([]);
export const TaskUpdateInputSchema = z.object({
  task_id: IdSchema,
  expected_revision: z.number().int().nonnegative(),
  review_snapshot: ReviewSnapshotSchema.optional().describe("审查和执行验证前由 task_check 获取的代码指纹；提交完成的审查或验证记录时必须传入，期间代码变化将拒绝写入"),
  reviewed_ids: z.object({ change_items: ReviewedIds(500), acceptance_criteria: ReviewedIds(100), validations: ReviewedIds(100) }).strict()
    .optional().describe("本次实际重新核验的条目 ID，按集合分类；须同时传该集合的完整列表和 review_snapshot。未指定的已有完成项保留旧指纹，不随完整回传自动刷新"),
  change_items: z.array(ChangeItemSchema).max(500).optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1).max(100).optional(),
  validations: z.array(ValidationRecordSchema).max(100).optional(),
  corrections: z.array(CorrectionSchema).max(100).optional(),
  knowledge_versions: z.array(z.object({ id: IdSchema, version: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100).optional(),
  phase: z.enum(["active", "closed", "aborted"]).optional(),
  abort_reason: TextSchema.optional(),
}).strict();

// 省略 ID 用于跨对话恢复唯一活跃任务；传入 ID 时也可查看已结束的历史任务。
export const TaskCheckInputSchema = z.object({ task_id: IdSchema.optional() }).strict();

export type TaskOpenInput = z.infer<typeof TaskOpenInputSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;
