import { z } from "zod";
import { IdSchema, RelativePathSchema, ReviewSnapshotSchema, TextSchema } from "../domain/common.js";

/** 执行计划只定义本次应运行什么；不接收调用方声明的退出码或通过结果。 */
export const ValidationPlanInputSchema = z.object({
  checks: z.array(z.object({ id: IdSchema, description: TextSchema,
    command: z.string().min(1).max(1024).regex(/^[a-zA-Z0-9_./:-]+$/),
    args: z.array(z.string().max(2000).refine(value => !value.includes("\0"))).max(40),
    cwd: z.union([z.literal("."), RelativePathSchema]).default("."),
    timeout_ms: z.number().int().min(100).max(120_000).default(60_000),
    acceptance_ids: z.array(IdSchema).min(1).max(100),
    source_paths: z.array(RelativePathSchema).max(10).default([]),
  }).strict()).max(20),
  not_applicable_reason: z.string().trim().min(10).max(2000).optional(),
}).strict().superRefine((plan, ctx) => {
  if ((!plan.checks.length) !== !!plan.not_applicable_reason) ctx.addIssue({ code: "custom", message: "无自动检查时必须说明不适用原因；有检查时不填写该原因" });
  if (new Set(plan.checks.map(item => item.id)).size !== plan.checks.length) ctx.addIssue({ code: "custom", message: "检查计划 ID 不能重复" });
  if (plan.checks.some(item => new Set(item.acceptance_ids).size !== item.acceptance_ids.length)) ctx.addIssue({ code: "custom", message: "检查关联的验收 ID 不能重复" });
});
export const ValidationPlanRecordSchema = z.object({ plan: ValidationPlanInputSchema,
  source_versions: z.array(z.object({ path: RelativePathSchema, sha256: ReviewSnapshotSchema }).strict()).max(40),
  version: ReviewSnapshotSchema, recorded_at: z.string().datetime({ offset: true }) }).strict();
export const ValidationRunSchema = z.object({ schema_version: z.literal(1), id: IdSchema, task_id: IdSchema,
  repo_identity: z.string(), worktree_path: z.string(), plan_version: ReviewSnapshotSchema, check_id: IdSchema,
  command: z.string(), args: z.array(z.string()), cwd: z.string(),
  started_at: z.string().datetime({ offset: true }), finished_at: z.string().datetime({ offset: true }),
  start_snapshot: ReviewSnapshotSchema, end_snapshot: ReviewSnapshotSchema.nullable(),
  exit_code: z.number().int().nullable(), signal: z.string().nullable(),
  state: z.enum(["passed", "failed", "timed_out", "cancelled", "start_failed", "stale"]),
  output: z.string().max(20_000), output_sha256: ReviewSnapshotSchema, output_truncated: z.boolean(),
  error: z.string().max(1000).optional(),
}).strict();
export type ValidationPlanInput = z.infer<typeof ValidationPlanInputSchema>;
export type ValidationPlanRecord = z.infer<typeof ValidationPlanRecordSchema>;
export type ValidationRun = z.infer<typeof ValidationRunSchema>;
