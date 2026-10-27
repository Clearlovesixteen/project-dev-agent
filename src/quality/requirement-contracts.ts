import { z } from "zod";
import {
  IdSchema,
  RelativePathSchema,
  ReviewSnapshotSchema,
  TextSchema,
} from "../domain/common.js";
/** 原型、PRD与本轮原话保留独立版本。服务核验可读性和指纹，不代替视觉或业务判断。 */
export const RequirementSourceInput = z
  .object({
    id: IdSchema,
    kind: z.enum(["request", "correction", "document", "image", "unavailable"]),
    path: RelativePathSchema.optional(),
    sha256: ReviewSnapshotSchema.optional(),
    quote: TextSchema.optional(),
    correction_id: IdSchema.optional(),
    locator: TextSchema.optional(),
    reason: TextSchema.optional(),
  })
  .strict();
export const RequirementSourceRecord = z
  .object({
    input: RequirementSourceInput,
    fingerprint: ReviewSnapshotSchema,
    recorded_at: z.string(),
  })
  .strict();
export const RequirementCheckSchema = z
  .object({
    kind: z.enum([
      "technical",
      "business",
      "contract",
      "interaction",
      "visual",
    ]),
    source_ids: z.array(IdSchema).min(1).max(10),
  })
  .strict()
  .refine(
    (value) => new Set(value.source_ids).size === value.source_ids.length,
    "验收来源ID不能重复",
  );
export const BusinessAssessmentSchema = z
  .object({
    state: z.enum(["unchanged", "changed", "unknown"]),
    reason: z.string().trim().min(10).max(2000),
    model_ids: z.array(IdSchema).max(20),
    delta_ids: z.array(IdSchema).max(20),
  })
  .strict();

/** 改变验收含义须保留需求修订依据，不能把缺少原型的视觉项静默改成技术项。 */
export const AcceptanceRevisionInput = z
  .object({
    reason: z.string().trim().min(10).max(2000),
    correction_id: IdSchema,
  })
  .strict();
export const AcceptanceRevisionRecord = z
  .object({
    before: z
      .array(
        z
          .object({
            id: IdSchema,
            description: TextSchema,
            check: RequirementCheckSchema,
          })
          .strict(),
      )
      .max(100),
    after: z
      .array(
        z
          .object({
            id: IdSchema,
            description: TextSchema,
            check: RequirementCheckSchema,
          })
          .strict(),
      )
      .max(100),
    reason: TextSchema,
    correction_id: IdSchema.optional(),
    recorded_at: z.string(),
  })
  .strict();
