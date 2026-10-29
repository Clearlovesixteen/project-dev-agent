import { z } from "zod";
import { IdSchema } from "../domain/common.js";
import { ConcretePath, HASH, ShortText } from "./fields.js";

const Responsibility = z.enum(["frontend", "backend", "shared", "unknown"]);
export const Basis = z.enum(["observed", "intended", "inferred"]);
export const FileSource = z.object({ path: ConcretePath, sha256: HASH, line: z.number().int().positive(), quote: ShortText }).strict();
export const ModelMetadata = z.object({
  module: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(200),
  scope: z.array(ConcretePath).min(1).max(10), summary: ShortText,
  entities: z.array(z.object({ id: IdSchema.optional(), name: z.string().max(100), meaning: ShortText,
    aliases: z.array(z.string().trim().min(1).max(100)).max(8).optional(),
    source_ids: z.array(IdSchema).min(1).max(10).optional() }).strict()).max(10),
  flows: z.array(z.object({ name: z.string().max(100), steps: z.array(ShortText).min(1).max(8) }).strict()).max(5),
  related_paths: z.array(ConcretePath).min(1).max(20), questions: z.array(ShortText).max(10),
}).strict();
const LegacyRule = z.object({ description: ShortText, responsibility: Responsibility }).strict();
export const LegacyContent = ModelMetadata.extend({ id: IdSchema, rules: z.array(LegacyRule).max(10), sources: z.array(FileSource).min(1).max(10) });

/** 文件证据绑定索引哈希；会话要求绑定本项目已保存的任务原文，均不等于人工批准。 */
export const ModelSource = z.union([
  FileSource.extend({ id: IdSchema, kind: z.enum(["code", "document"]) }),
  z.object({ id: IdSchema, kind: z.literal("task"), task_id: IdSchema, correction_id: IdSchema.optional(), quote: ShortText, sha256: HASH.optional() }).strict(),
]);
export const BusinessRule = z.object({
  id: IdSchema, description: ShortText, responsibility: Responsibility, basis: Basis,
  conditions: z.array(ShortText).min(1).max(8), exceptions: z.array(ShortText).max(8),
  source_ids: z.array(IdSchema).min(1).max(10),
  assertion: z.object({ subject: z.string().trim().min(1).max(120), property: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(200) }).strict().optional(),
}).strict();
export const BusinessRelation = z.object({
  id: IdSchema, rule_ids: z.array(IdSchema).min(1).max(10),
  kind: z.enum(["enforced_by", "used_by", "depends_on"]), target_path: ConcretePath,
  target_model_id: IdSchema.optional(), reason: ShortText, source_ids: z.array(IdSchema).min(1).max(10),
  entity_ids: z.array(IdSchema).min(1).max(10).optional(),
  target_entity_ids: z.array(IdSchema).min(1).max(10).optional(),
  target_rule_ids: z.array(IdSchema).min(1).max(20).optional(),
}).strict();
export const ModelContentV2 = ModelMetadata.extend({
  id: IdSchema, rules: z.array(BusinessRule).min(1).max(20), sources: z.array(ModelSource).min(1).max(30),
  relations: z.array(BusinessRelation).max(30),
});
const EvidenceVersions = z.array(z.object({ id: IdSchema, fingerprint: HASH }).strict()).min(1).max(10);
export const SavedRule = BusinessRule.extend({ evidence_versions: EvidenceVersions });
export const SavedRelation = BusinessRelation.extend({
  evidence_versions: EvidenceVersions, rule_versions: EvidenceVersions, target_sha256: HASH, target_model_revision: z.number().int().positive().optional(),
  target_rule_versions: z.array(z.object({ id: IdSchema, fingerprint: HASH }).strict()).min(1).max(20).optional(),
  entity_versions: z.array(z.object({ id: IdSchema, fingerprint: HASH }).strict()).min(1).max(10).optional(),
  target_entity_versions: z.array(z.object({ id: IdSchema, fingerprint: HASH }).strict()).min(1).max(10).optional(),
});
const SavedMetadata = {
  project: z.string(), revision: z.number().int().positive(), recorded_at: z.string(), scan_id: HASH,
  related_versions: z.array(z.object({ path: ConcretePath, sha256: HASH }).strict()).min(1).max(20),
};
export const SavedLegacyModel = LegacyContent.extend({ schema_version: z.literal(1), ...SavedMetadata });
export const SavedModelV2 = ModelContentV2.extend({
  schema_version: z.literal(2), ...SavedMetadata, revision_reason: ShortText,
  rules: z.array(SavedRule).min(1).max(20), relations: z.array(SavedRelation).max(30),
});
export const SavedModelSchema = z.discriminatedUnion("schema_version", [SavedLegacyModel, SavedModelV2]);
export type SavedModel = z.infer<typeof SavedModelSchema>;
export type ModelV2 = z.infer<typeof SavedModelV2>;
export type SourceV2 = z.infer<typeof ModelSource>;
export type RuleV2 = z.infer<typeof BusinessRule>;
export type RelationV2 = z.infer<typeof BusinessRelation>;

/** 只提交实际复核的条目。未提交的条目及其证据版本原样保留，避免整份模型被误刷新。 */
export const ModelPatch = z.object({
  metadata: ModelMetadata.partial().optional(),
  upsert_sources: z.array(ModelSource).max(30).optional(), remove_source_ids: z.array(IdSchema).max(30).optional(),
  upsert_rules: z.array(BusinessRule).max(20).optional(), remove_rule_ids: z.array(IdSchema).max(20).optional(),
  upsert_relations: z.array(BusinessRelation).max(30).optional(), remove_relation_ids: z.array(IdSchema).max(30).optional(),
}).strict();

// MCP 根参数保持对象类型，旧版完整记录仍兼容；具体分支在服务中按对应内容契约严格解析。
export const ModelRecordInput = ModelMetadata.partial().extend({
  id: IdSchema, scan_id: HASH, expected_revision: z.number().int().nonnegative().default(0),
  schema_version: z.literal(2).optional(), revision_reason: ShortText.optional(),
  rules: z.array(z.union([BusinessRule, LegacyRule])).max(20).optional(),
  sources: z.array(z.union([ModelSource, FileSource])).min(1).max(30).optional(),
  relations: z.array(BusinessRelation).max(30).optional(), patch: ModelPatch.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.patch) {
    if (input.schema_version !== 2 || !input.revision_reason) ctx.addIssue({ code: "custom", message: "局部修订需要 schema_version: 2 和 revision_reason" });
    const fields = [...Object.keys(ModelMetadata.shape), "rules", "sources", "relations"];
    if (fields.some((key) => input[key as keyof typeof input] !== undefined)) ctx.addIssue({ code: "custom", message: "局部修订只提交 patch，不能混合完整模型字段" });
    if (!Object.values(input.patch).some((value) => Array.isArray(value) ? value.length : Object.keys(value ?? {}).length)) ctx.addIssue({ code: "custom", message: "局部修订不能为空" });
  } else {
    // MCP 会扩展 project 字段；内容校验仅提取模型字段，不能把连接范围当成模型内容。
    const fields = ["id", ...Object.keys(ModelMetadata.shape), "rules", "sources", "relations"];
    const body = Object.fromEntries(fields.filter((key) => input[key as keyof typeof input] !== undefined).map((key) => [key, input[key as keyof typeof input]]));
    const parsed = (input.schema_version === 2 ? ModelContentV2 : LegacyContent).safeParse(body);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    if (input.schema_version === 2 && !input.revision_reason) ctx.addIssue({ code: "custom", message: "新版模型需要 revision_reason，说明建立或迁移依据" });
  }
});
export type RecordRequest = z.infer<typeof ModelRecordInput>;
