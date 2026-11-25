import { z } from "zod";
import { HASH } from "../understanding/fields.js";

/**
 * 业务模型的可信度状态只描述证据和复核状态，不把模型正文中的 AI 判断
 * 当作已确认规则。旧快照没有这个字段时必须按 candidate 处理。
 */
export const ModelTrustState = z.enum(["candidate", "verified", "stale", "conflict", "rejected"]);
export type ModelTrustState = z.infer<typeof ModelTrustState>;

export const ModelTrustSchema = z.object({
  state: ModelTrustState,
  reason: z.string().trim().min(1).max(500).optional(),
  source_stamp_id: HASH.optional(),
  review_snapshot: HASH.optional(),
  verified_at: z.string().datetime({ offset: true }).optional(),
  verified_by: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "verified") {
    for (const field of ["source_stamp_id", "review_snapshot", "verified_at", "verified_by"] as const)
      if (!value[field]) ctx.addIssue({ code: "custom", path: [field], message: `verified 状态必须有 ${field}` });
  }
  if (["stale", "conflict", "rejected"].includes(value.state) && !value.reason)
    ctx.addIssue({ code: "custom", path: ["reason"], message: "降级或拒绝状态必须说明原因" });
});
export type ModelTrust = z.infer<typeof ModelTrustSchema>;

export const ModelVerificationInputSchema = z.object({
  operation_id: z.string().trim().min(1).max(200),
  task_id: z.string().trim().min(1).max(200),
  model_id: z.string().trim().min(1).max(200),
  snapshot_id: HASH,
  review_snapshot: HASH,
  base_snapshot_id: HASH.optional(),
  expected_transaction_id: HASH.nullable().optional(),
}).strict();
export type ModelVerificationInput = z.infer<typeof ModelVerificationInputSchema>;

/** 旧版本没有显式可信度字段，安全迁移为待复核候选。 */
export function modelTrust(value: unknown): ModelTrust {
  const parsed = ModelTrustSchema.safeParse(value);
  return parsed.success ? parsed.data : { state: "candidate", reason: "legacy_snapshot_requires_review" };
}

/** 当前源码匹配时，候选可作阅读线索，已验收模型可携任务核验记录使用。 */
export function isUsableModelTrust(trust: ModelTrust): boolean {
  return trust.state === "candidate" || trust.state === "verified";
}

/** 只有当前源码唯一匹配且快照已被任务验收流程标记 verified 才能称为可信。 */
export function isVerifiedTrust(trust: ModelTrust, viewState: string | undefined): boolean {
  return trust.state === "verified" && viewState === "matched";
}
