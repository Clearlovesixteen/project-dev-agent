import { BusinessCheckSchema, EvaluationTagSchema, ImplementationBaselineSchema, ReuseExceptionSchema } from "../quality/contracts.js";
import { ImplementationBasisRecordSchema } from "../quality/basis-contracts.js";
import { ValidationPlanRecordSchema } from "../quality/validation-contracts.js";
import { BusinessDeltaRecordSchema, BusinessDeltaCheckSchema } from "../quality/business-delta-contracts.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { EvidenceSchema, IdSchema, RelativePathSchema, ReviewSnapshotSchema, SourceSchema, TextSchema } from "./common.js";

const ReviewFields = {
  reviewed_by: TextSchema.optional(),
  evidence: z.array(EvidenceSchema).max(100).default([]),
  review_snapshot: ReviewSnapshotSchema.optional(),
};

export const ChangeItemSchema = z.object({
  id: IdSchema,
  target_path: RelativePathSchema,
  action: z.enum(["modify", "verify"]),
  requirement: TextSchema,
  rationale: TextSchema,
  sources: z.array(SourceSchema).min(1).max(100),
  status: z.enum(["pending", "checked", "skipped"]).default("pending"),
  ...ReviewFields,
  skip_reason: TextSchema.optional(),
  reuse_exception: ReuseExceptionSchema.optional(),
}).strict().superRefine((item, ctx) => {
  if (item.status !== "pending" && !item.reviewed_by) {
    ctx.addIssue({ code: "custom", path: ["reviewed_by"], message: "已完成的审查决定必须填写审查者" });
  }
  if (item.status === "checked" && item.evidence.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "仅有文件改动不能作为审查证据" });
  }
  if (item.status === "skipped" && !item.skip_reason) {
    ctx.addIssue({ code: "custom", path: ["skip_reason"], message: "跳过检查必须填写明确原因" });
  }
  if (item.status !== "skipped" && item.skip_reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["skip_reason"], message: "只有已跳过的检查项才能填写跳过原因" });
  }
});

export const AcceptanceCriterionSchema = z.object({
  business_delta_check: BusinessDeltaCheckSchema.optional(),
  business_check: BusinessCheckSchema.optional(),
  id: IdSchema,
  description: TextSchema,
  status: z.enum(["pending", "checked"]).default("pending"),
  ...ReviewFields,
}).strict().superRefine((criterion, ctx) => {
  if (criterion.status === "checked" && (!criterion.reviewed_by || criterion.evidence.length === 0)) {
    ctx.addIssue({ code: "custom", message: "已检查的验收项必须填写审查者和证据" });
  }
});

export const ValidationRecordSchema = z.object({
  run_id: IdSchema.optional(),
  id: IdSchema,
  description: TextSchema,
  outcome: z.enum(["passed", "failed", "not_run"]),
  evidence: z.array(EvidenceSchema).max(100).default([]),
  review_snapshot: ReviewSnapshotSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.outcome !== "not_run" && record.evidence.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "已执行的验证必须提供证据" });
  }
});

export const CorrectionSchema = z.object({
  id: IdSchema,
  description: TextSchema,
  rationale: TextSchema,
  sources: z.array(SourceSchema).min(1).max(100),
}).strict();

export const TaskSchema = z.object({
  schema_version: z.literal(1),
  id: IdSchema,
  revision: z.number().int().nonnegative(),
  repo_identity: TextSchema,
  worktree_path: z.string().max(4_096).refine(isAbsolute, "工作树路径必须是绝对路径"),
  baseline_head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  baseline_branch: TextSchema.nullable(),
  phase: z.enum(["active", "closed", "aborted"]),
  requirement: TextSchema,
  evaluation: EvaluationTagSchema.optional(),
  implementation_baseline: ImplementationBaselineSchema.optional(),
  implementation_policy: z.literal(1).optional(),
  implementation_bases: z.array(ImplementationBasisRecordSchema).max(10).optional(),
  validation_policy: z.literal(1).optional(),
  validation_plans: z.array(ValidationPlanRecordSchema).max(10).optional(),
  business_deltas: z.array(BusinessDeltaRecordSchema).max(20).optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1).max(100),
  knowledge_versions: z.array(z.object({ id: IdSchema, version: TextSchema }).strict()).max(100).default([]),
  change_items: z.array(ChangeItemSchema).max(500).default([]),
  validations: z.array(ValidationRecordSchema).max(100).default([]),
  corrections: z.array(CorrectionSchema).max(100).default([]),
  abort_reason: TextSchema.optional(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict().superRefine((task, ctx) => {
  for (const key of ["acceptance_criteria", "change_items", "validations", "corrections", "knowledge_versions"] as const) {
    const ids = task[key].map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: [key], message: "同一任务集合中的 ID 必须唯一" });
    }
  }
  if (task.phase === "closed") {
    if (task.change_items.length === 0 || task.change_items.some((item) => item.status === "pending")) {
      ctx.addIssue({ code: "custom", path: ["change_items"], message: "关闭任务需要非空且已全部审查的关联改动清单" });
    }
    if (task.acceptance_criteria.some((criterion) => criterion.status !== "checked")) {
      ctx.addIssue({ code: "custom", path: ["acceptance_criteria"], message: "关闭任务前必须完成所有验收项的检查" });
    }
    if (task.validations.some((record) => record.outcome !== "passed")) {
      ctx.addIssue({ code: "custom", path: ["validations"], message: "关闭任务前必须处理失败或未执行的验证" });
    }
  }
  if (task.phase === "aborted" && !task.abort_reason) {
    ctx.addIssue({ code: "custom", path: ["abort_reason"], message: "中止任务必须填写原因，并保留未完成项" });
  }
  if (task.phase !== "aborted" && task.abort_reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["abort_reason"], message: "只有已中止的任务才能填写中止原因" });
  }
  if (Date.parse(task.updated_at) < Date.parse(task.created_at)) {
    ctx.addIssue({ code: "custom", path: ["updated_at"], message: "更新时间不能早于创建时间" });
  }
});

export type ChangeItem = z.infer<typeof ChangeItemSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;
export type Task = z.infer<typeof TaskSchema>;
