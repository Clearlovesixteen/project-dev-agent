import { z } from "zod";
import { IdSchema, TextSchema } from "../domain/common.js";
import { AcceptanceCriterionSchema, ChangeItemSchema, CorrectionSchema, ValidationRecordSchema } from "../domain/task.js";

export const TaskOpenInputSchema = z.object({
  requirement: TextSchema,
  acceptance_criteria: z.array(z.object({ id: IdSchema, description: TextSchema }).strict()).min(1).max(100),
}).strict();

export const TaskUpdateInputSchema = z.object({
  task_id: IdSchema,
  expected_revision: z.number().int().nonnegative(),
  change_items: z.array(ChangeItemSchema).max(500).optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1).max(100).optional(),
  validations: z.array(ValidationRecordSchema).max(100).optional(),
  corrections: z.array(CorrectionSchema).max(100).optional(),
  knowledge_versions: z.array(z.object({ id: IdSchema, version: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100).optional(),
  phase: z.enum(["active", "closed", "aborted"]).optional(),
  abort_reason: TextSchema.optional(),
}).strict();

export const TaskCheckInputSchema = z.object({ task_id: IdSchema.optional() }).strict();

export type TaskOpenInput = z.infer<typeof TaskOpenInputSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;
