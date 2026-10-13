import { isAbsolute } from "node:path";
import { z } from "zod";
import { EvidenceSchema, IdSchema, RelativePathSchema, SourceSchema, TextSchema } from "./common.js";

const ReviewFields = {
  reviewed_by: TextSchema.optional(),
  evidence: z.array(EvidenceSchema).max(100).default([]),
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
}).strict().superRefine((item, ctx) => {
  if (item.status !== "pending" && !item.reviewed_by) {
    ctx.addIssue({ code: "custom", path: ["reviewed_by"], message: "A completed decision requires a reviewer" });
  }
  if (item.status === "checked" && item.evidence.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "Changed files alone are not review evidence" });
  }
  if (item.status === "skipped" && !item.skip_reason) {
    ctx.addIssue({ code: "custom", path: ["skip_reason"], message: "Skipping requires an explicit reason" });
  }
  if (item.status !== "skipped" && item.skip_reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["skip_reason"], message: "Only a skipped item can have a skip reason" });
  }
});

export const AcceptanceCriterionSchema = z.object({
  id: IdSchema,
  description: TextSchema,
  status: z.enum(["pending", "checked"]).default("pending"),
  ...ReviewFields,
}).strict().superRefine((criterion, ctx) => {
  if (criterion.status === "checked" && (!criterion.reviewed_by || criterion.evidence.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Checked acceptance criteria require a reviewer and evidence" });
  }
});

export const ValidationRecordSchema = z.object({
  id: IdSchema,
  description: TextSchema,
  outcome: z.enum(["passed", "failed", "not_run"]),
  evidence: z.array(EvidenceSchema).max(100).default([]),
}).strict().superRefine((record, ctx) => {
  if (record.outcome !== "not_run" && record.evidence.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "Executed validation requires evidence" });
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
  worktree_path: z.string().max(4_096).refine(isAbsolute, "Worktree path must be absolute"),
  baseline_head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  baseline_branch: TextSchema.nullable(),
  phase: z.enum(["active", "closed", "aborted"]),
  requirement: TextSchema,
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
      ctx.addIssue({ code: "custom", path: [key], message: "IDs must be unique within each task collection" });
    }
  }
  if (task.phase === "closed") {
    if (task.change_items.length === 0 || task.change_items.some((item) => item.status === "pending")) {
      ctx.addIssue({ code: "custom", path: ["change_items"], message: "Closing requires a nonempty, fully reviewed change checklist" });
    }
    if (task.acceptance_criteria.some((criterion) => criterion.status !== "checked")) {
      ctx.addIssue({ code: "custom", path: ["acceptance_criteria"], message: "Closing requires all acceptance criteria to be checked" });
    }
    if (task.validations.some((record) => record.outcome !== "passed")) {
      ctx.addIssue({ code: "custom", path: ["validations"], message: "Failed or unexecuted validation must be resolved before closing" });
    }
  }
  if (task.phase === "aborted" && !task.abort_reason) {
    ctx.addIssue({ code: "custom", path: ["abort_reason"], message: "Aborting requires a reason and preserves incomplete items" });
  }
  if (task.phase !== "aborted" && task.abort_reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["abort_reason"], message: "Only an aborted task can have an abort reason" });
  }
  if (Date.parse(task.updated_at) < Date.parse(task.created_at)) {
    ctx.addIssue({ code: "custom", path: ["updated_at"], message: "Update time cannot precede creation time" });
  }
});

export type ChangeItem = z.infer<typeof ChangeItemSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;
export type Task = z.infer<typeof TaskSchema>;
