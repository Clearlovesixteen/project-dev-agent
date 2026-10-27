import { z } from "zod";
import {
  IdSchema,
  RelativePathSchema,
  ReviewSnapshotSchema,
  TextSchema,
} from "../domain/common.js";
export const FeedbackInputSchema = z
  .object({
    id: IdSchema,
    rule: TextSchema,
    category: z.enum(["code_convention", "business_rule", "interaction"]),
    audience: z.enum(["personal", "project", "task"]),
    paths: z.array(RelativePathSchema).max(20),
    conditions: z.array(TextSchema).min(1).max(10),
    source: z
      .object({
        quote: z.string().trim().min(4).max(2000),
        session_id: IdSchema.optional(),
        message_id: z.string().max(120).optional(),
      })
      .strict(),
    supersedes_id: IdSchema.optional(),
    status: z.enum(["candidate", "disabled"]).default("candidate"),
  })
  .strict();
export const FeedbackRecordSchema = z
  .object({
    input: FeedbackInputSchema,
    source: z
      .object({
        session: IdSchema,
        message_id: z.string(),
        line: z.number().int().positive(),
        quote: TextSchema,
        source_hash: ReviewSnapshotSchema,
      })
      .strict(),
    fingerprint: ReviewSnapshotSchema,
    recorded_at: z.string(),
  })
  .strict();
export const FeedbackReviewSchema = z
  .object({
    version: ReviewSnapshotSchema,
    decisions: z
      .array(
        z
          .object({
            id: IdSchema,
            disposition: z.enum(["apply", "not_applicable"]),
            reason: z.string().trim().min(10).max(2000),
            acceptance_ids: z.array(IdSchema).max(100),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.decisions.map((item) => item.id)).size !==
        value.decisions.length ||
      value.decisions.some(
        (item) =>
          new Set(item.acceptance_ids).size !== item.acceptance_ids.length,
      )
    )
      ctx.addIssue({ code: "custom", message: "纠正选择ID及关联验收不能重复" });
  });
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;
