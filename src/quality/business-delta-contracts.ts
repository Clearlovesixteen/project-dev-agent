import { z } from "zod";
import { IdSchema, ReviewSnapshotSchema, TextSchema } from "../domain/common.js";
import { BusinessRuleV3, ModelMetadata, ModelSource, SavedRule, SavedRuleV3 } from "../understanding/model-contracts.js";
import { ScenarioRetirement } from "../understanding/scenario-retirement.js";

export const BusinessDeltaCheckSchema = z.object({ delta_id: IdSchema, delta_fingerprint: ReviewSnapshotSchema, scenario_id: IdSchema }).strict();
export type BusinessDeltaCheck = z.infer<typeof BusinessDeltaCheckSchema>;

/** 草案只表达需求预期；当前代码行为由服务读取旧模型，不能由调用方伪造前镜像。 */
export const BusinessDeltaInputSchema = z.object({
  id: IdSchema, model_id: IdSchema, base_revision: z.number().int().nonnegative(),
  new_model: ModelMetadata.omit({ related_paths: true }).optional(),
  operation: z.enum(["add", "modify", "remove"]), rule_id: IdSchema,
  expected_rule_fingerprint: ReviewSnapshotSchema.optional(),
  supersedes_id: IdSchema.optional(), reason: TextSchema,
  acceptance_ids: z.array(IdSchema).min(1).max(20),
  proposed_rule: BusinessRuleV3.optional(), sources: z.array(ModelSource).min(1).max(10),
  scenario_retirements: z.array(ScenarioRetirement).max(30).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.scenario_retirements?.some(item => input.operation !== "modify" || item.rule_id !== input.rule_id ||
    !input.sources.some(source => source.id === item.source_id))) ctx.addIssue({ code: "custom", message: "场景退役须关联本次修改的规则和草案需求来源" });
  if (new Set(input.acceptance_ids).size !== input.acceptance_ids.length || new Set(input.sources.map(source => source.id)).size !== input.sources.length) ctx.addIssue({ code: "custom", message: "草案验收和来源 ID 不能重复" });
  if (input.sources.some(source => source.kind === "code")) ctx.addIssue({ code: "custom", message: "草案需求来源使用文档或任务原文，代码前镜像由服务读取" });
  if (input.operation === "remove" ? input.proposed_rule !== undefined : !input.proposed_rule) ctx.addIssue({ code: "custom", message: "新增或修改需要预期规则；删除不填写预期规则" });
  if (input.operation === "add" ? input.expected_rule_fingerprint !== undefined : !input.expected_rule_fingerprint) ctx.addIssue({ code: "custom", message: "修改或删除需要旧规则指纹；新增不能带旧规则指纹" });
  if (input.proposed_rule && (input.proposed_rule.id !== input.rule_id || input.proposed_rule.basis !== "intended" || input.proposed_rule.source_ids.some(id => !input.sources.some(source => source.id === id)))) ctx.addIssue({ code: "custom", message: "预期规则须同 ID、basis:intended，并引用本草案需求来源" });
  if (input.base_revision === 0 ? input.operation !== "add" || !input.new_model || !input.proposed_rule?.semantics || !input.proposed_rule.bindings?.length : !!input.new_model)
    ctx.addIssue({ code: "custom", message: "从零建立新业务时，使用 base_revision:0、add、new_model 与含条件及代码位置的预期规则" });
});
export const BusinessDeltaRecordSchema = z.object({
  input: BusinessDeltaInputSchema, fingerprint: ReviewSnapshotSchema,
  base_snapshot_id: ReviewSnapshotSchema.optional(),
  before_rule: z.union([SavedRuleV3, SavedRule]).nullable(), recorded_at: z.string().datetime({ offset: true }),
}).strict();
export const BusinessDeltaApplyInputSchema = z.object({
  delta_id: IdSchema, observed_rule: BusinessRuleV3.optional(),
  sources: z.array(ModelSource).min(1).max(10),
}).strict();
/** 回执由服务发布，不接受 task_update 自报。快照只覆盖当前工作树，不证明业务语义。 */
export const BusinessDeltaReceiptSchema = z.object({
  task_id: IdSchema, delta_id: IdSchema, delta_fingerprint: ReviewSnapshotSchema,
  model_id: IdSchema, model_revision: z.number().int().positive(), rule_id: IdSchema,
  operation: z.enum(["add", "modify", "remove"]), published_rule_fingerprint: ReviewSnapshotSchema.nullable(),
  review_snapshot: ReviewSnapshotSchema, applied_at: z.string().datetime({ offset: true }),
}).strict();
export type BusinessDeltaInput = z.infer<typeof BusinessDeltaInputSchema>;
export type BusinessDeltaRecord = z.infer<typeof BusinessDeltaRecordSchema>;
export type BusinessDeltaApplyInput = z.infer<typeof BusinessDeltaApplyInputSchema>;
export type BusinessDeltaReceipt = z.infer<typeof BusinessDeltaReceiptSchema>;

/** 兼容运行时允许读取此结构，只有增强写入模式可以建立它。 */
export function enhancedBusinessDelta(input: BusinessDeltaInput): boolean {
  return !!input.new_model || !!input.proposed_rule?.semantics || !!input.proposed_rule?.bindings?.length
    || input.sources.some(source => source.kind === "task" && !!source.requirement_source_id);
}
