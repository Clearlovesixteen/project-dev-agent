import { z } from "zod";
import { IdSchema, RelativePathSchema } from "../domain/common.js";

export const MAP_DIR = ".project-dev/local/understanding";
export const HASH = z.string().regex(/^[a-f0-9]{64}$/);
export const ShortText = z.string().trim().min(1).max(1_000);
export const ConcretePath = RelativePathSchema.refine((path) => !/[\*?\[\]]/.test(path), "请使用具体的文件或目录路径");
export const FileSchema = z.object({
  path: ConcretePath, sha256: HASH, bytes: z.number().int().nonnegative(), module: z.string(),
  role: z.enum(["entry", "page", "shared", "api", "test", "config", "document", "source"]),
  imports: z.array(z.object({ specifier: z.string().max(300), target: ConcretePath.nullable(), line: z.number().int().positive() }).strict()).max(40),
  imports_truncated: z.boolean(),
  package: z.object({ dependencies: z.array(z.object({ name: z.string().max(200), declared: z.string().max(200) }).strict()).max(120),
    scripts: z.array(z.string().max(100)).max(40), truncated: z.boolean() }).strict().optional(),
}).strict();
export type MapFile = z.infer<typeof FileSchema>;
export const MapSchema = z.object({
  schema_version: z.literal(1), project: z.string(), repo_identity: z.string(), scan_id: HASH,
  head: z.string(), scanned_at: z.string(), config_hash: HASH, chunks: z.array(HASH).max(2_000),
  coverage: z.object({ discovered: z.number(), indexed: z.number(), excluded: z.number(), unreadable: z.number(),
    unsupported: z.number(), reused: z.number(), complete: z.boolean() }).strict(),
  diagnostics: z.array(z.object({ code: z.string(), message: z.string().max(500) }).strict()).max(100),
}).strict();
export type ProjectMap = z.infer<typeof MapSchema>;
export const ScanInput = z.object({}).strict();
export const ContextInput = z.object({ query: z.string().trim().max(2_000).default(""), paths: z.array(ConcretePath).max(30).default([]),
  modules: z.array(z.string().max(200)).max(20).default([]), limit: z.number().int().min(1).max(20).default(10) }).strict();
export const ModelContent = z.object({
  id: IdSchema, module: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(200),
  scope: z.array(ConcretePath).min(1).max(10), summary: ShortText,
  entities: z.array(z.object({ name: z.string().max(100), meaning: ShortText }).strict()).max(10),
  flows: z.array(z.object({ name: z.string().max(100), steps: z.array(ShortText).min(1).max(8) }).strict()).max(5),
  rules: z.array(z.object({ description: ShortText, responsibility: z.enum(["frontend", "backend", "shared", "unknown"]) }).strict()).max(10),
  related_paths: z.array(ConcretePath).min(1).max(20),
  sources: z.array(z.object({ path: ConcretePath, sha256: HASH, line: z.number().int().positive(), quote: ShortText }).strict()).min(1).max(10),
  questions: z.array(ShortText).max(10),
}).strict();
export const ModelRecordInput = ModelContent.extend({ scan_id: HASH, expected_revision: z.number().int().nonnegative().default(0) }).strict();
export const SavedModelSchema = ModelContent.extend({ schema_version: z.literal(1), project: z.string(),
  revision: z.number().int().positive(), recorded_at: z.string(), scan_id: HASH,
  related_versions: z.array(z.object({ path: ConcretePath, sha256: HASH }).strict()).min(1).max(20) }).strict();
export type SavedModel = z.infer<typeof SavedModelSchema>;
