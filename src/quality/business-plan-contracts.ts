import { z } from "zod";
import { IdSchema, RelativePathSchema, ReviewSnapshotSchema, TextSchema } from "../domain/common.js";
import { CodeBindingInput, SavedCodeBinding } from "../understanding/semantic-contracts.js";

const RuleRef = z.object({ model_id: IdSchema, rule_id: IdSchema, delta_id: IdSchema.optional() }).strict();
const AcceptanceIds = z.array(IdSchema).min(1).max(20);
/** Agent 从 PRD/SDD 或原话中提取，程序核对原文、引用和版本，不代写第二份规格。 */
export const BusinessPlanInput = z.object({
  input_items: z.array(z.object({ id: IdSchema, source_id: IdSchema, quote: z.string().trim().min(1).max(1000),
    kind: z.enum(["behavior", "constraint", "design", "unresolved"]), acceptance_ids: AcceptanceIds }).strict()).min(1).max(40),
  rules: z.array(RuleRef).min(1).max(20),
  decisions: z.array(z.object({ id: IdSchema, model_id: IdSchema, rule_id: IdSchema, binding_id: IdSchema,
    action: z.enum(["modify", "verify", "protect", "not_applicable"]), reason: TextSchema, acceptance_ids: AcceptanceIds }).strict()).min(1).max(60),
  scenarios: z.array(z.object({ id: IdSchema, model_id: IdSchema, rule_id: IdSchema,
    case_id: IdSchema.optional(), preserve_id: IdSchema.optional(), acceptance_id: IdSchema, check_id: IdSchema,
    test_file: RelativePathSchema, test_name: z.string().trim().min(1).max(300),
  }).strict().refine(value => !!value.case_id !== !!value.preserve_id, "场景对应一个条件样例或一个保留行为")).min(1).max(60),
  supporting_changes: z.array(z.object({ path: RelativePathSchema, reason: TextSchema, acceptance_ids: AcceptanceIds }).strict()).max(20).default([]),
  related_checks: z.array(z.object({ path: RelativePathSchema, action: z.enum(["verify", "protect", "not_applicable"]),
    reason: TextSchema, acceptance_ids: AcceptanceIds }).strict()).max(30).default([]),
}).strict().superRefine((plan, ctx) => {
  for (const items of [plan.input_items, plan.decisions, plan.scenarios]) if (new Set(items.map(item => item.id)).size !== items.length)
    ctx.addIssue({ code: "custom", message: "计划中的条目 ID 不能重复" });
  if (new Set(plan.rules.map(item => `${item.model_id}/${item.rule_id}`)).size !== plan.rules.length)
    ctx.addIssue({ code: "custom", message: "每条规则只引用一次" });
  if (new Set(plan.supporting_changes.map(item => item.path)).size !== plan.supporting_changes.length)
    ctx.addIssue({ code: "custom", message: "辅助修改路径不能重复" });
  if (new Set(plan.related_checks.map(item => item.path)).size !== plan.related_checks.length)
    ctx.addIssue({ code: "custom", message: "关联核对路径不能重复" });
});
const BoundTarget = z.object({ model_id: IdSchema, rule_id: IdSchema, rule_fingerprint: ReviewSnapshotSchema,
  dependency_fingerprint: ReviewSnapshotSchema.optional(),
  delta_fingerprint: ReviewSnapshotSchema.optional(), bindings: z.array(z.object({ input: CodeBindingInput,
    initial: SavedCodeBinding, baseline_sha256: ReviewSnapshotSchema, baseline_symbol_sha256: ReviewSnapshotSchema.nullable(),
  }).strict()).max(20),
}).strict();
export const BusinessPlanRecord = z.object({ input: BusinessPlanInput, targets: z.array(BoundTarget).min(1).max(20),
  // 固定规则实际读取的模型快照，旧计划可以缺少此字段。
  base_snapshot_ids: z.array(z.object({ model_id: IdSchema, snapshot_id: ReviewSnapshotSchema }).strict()).max(20).optional(),
  source_versions: z.array(z.object({ id: IdSchema, fingerprint: ReviewSnapshotSchema }).strict()).min(1).max(40),
  related_versions: z.array(z.object({ path: RelativePathSchema, sha256: ReviewSnapshotSchema }).strict()).max(30),
  fingerprint: ReviewSnapshotSchema,
  recorded_at: z.string().datetime({ offset: true }), recorded_snapshot: ReviewSnapshotSchema,
}).strict();
export type BusinessPlan = z.infer<typeof BusinessPlanInput>;
export type BusinessPlanRecord = z.infer<typeof BusinessPlanRecord>;
