import { z } from "zod";
import { IdSchema } from "../domain/common.js";
import { ConcretePath, HASH } from "./fields.js";
export { ConcretePath, HASH, ShortText } from "./fields.js";
export { ModelRecordInput, SavedModelSchema, type SavedModel } from "./model-contracts.js";

export const MAP_DIR = ".project-dev/local/understanding";
export const FileSchema = z.object({
  path: ConcretePath, sha256: HASH, bytes: z.number().int().nonnegative(), module: z.string(),
  role: z.enum(["entry", "page", "shared", "api", "test", "config", "document", "source"]),
  imports: z.array(z.object({ specifier: z.string().max(300), target: ConcretePath.nullable(), line: z.number().int().positive() }).strict()).max(40),
  imports_truncated: z.boolean(),
  stat_signature: HASH.optional(),
  symbols: z.array(z.string().max(96)).max(40).optional(), identifiers: z.array(z.string().max(96)).max(160).optional(), identifiers_truncated: z.boolean().optional(),
  package: z.object({ dependencies: z.array(z.object({ name: z.string().max(200), declared: z.string().max(200) }).strict()).max(120),
    scripts: z.array(z.string().max(100)).max(40), truncated: z.boolean() }).strict().optional(),
}).strict();
export type MapFile = z.infer<typeof FileSchema>;
export const MapSchema = z.object({
  schema_version: z.literal(1), project: z.string(), repo_identity: z.string(), scan_id: HASH,
  head: z.string(), scanned_at: z.string(), config_hash: HASH, chunks: z.array(HASH).max(2_000),
  coverage: z.object({ discovered: z.number(), indexed: z.number(), excluded: z.number(), unreadable: z.number(),
    unsupported: z.number(), reused: z.number(), complete: z.boolean(),
    content_reused: z.number().nonnegative().optional(), read_files: z.number().nonnegative().optional(), read_bytes: z.number().nonnegative().optional() }).strict(),
  diagnostics: z.array(z.object({ code: z.string(), message: z.string().max(500) }).strict()).max(100),
}).strict();
export type ProjectMap = z.infer<typeof MapSchema>;
export const ScanInput = z.object({}).strict();
export const ContextInput = z.object({ query: z.string().trim().max(2_000).default(""), paths: z.array(ConcretePath).max(30).default([]),
  modules: z.array(z.string().max(200)).max(20).default([]), limit: z.number().int().min(1).max(20).default(10),
  model_offset: z.number().int().min(0).max(200).default(0).describe("模型列表的分页起点；使用上次返回的 next_model_offset"),
  relation_depth: z.number().int().min(1).max(2).default(1).describe("业务关系展开层数，默认一层，最多两层；超出预算会明确截断"),
  model_id: IdSchema.optional().describe("按 ID 单独读取一个模型的完整详情，仍执行来源排除和版本核验"),
  model_revision: z.number().int().positive().optional().describe("读取详情时核对摘要中的修订号，防止两次查询间内容变化"),
  rule_ids: z.array(IdSchema).min(1).max(20).optional().describe("配合 model_id 只读取所需规则、关联关系及证据；省略则返回完整详情"),
}).strict().superRefine((value, ctx) => {
  if (value.rule_ids && !value.model_id) ctx.addIssue({ code: "custom", message: "按规则读取需要 model_id" });
});
