import { z } from "zod";
import { HASH } from "../understanding/fields.js";

/** 共享项目知识库的存储协议；模型内容本身仍由 understanding 的 schema 负责。 */
export const PROJECT_KNOWLEDGE_PROTOCOL = 1 as const;
export const PROJECT_KNOWLEDGE_DIR = "project-dev-agent" as const;

export const ProjectIdentitySchema = z.object({
  schema_version: z.literal(1),
  protocol_version: z.literal(PROJECT_KNOWLEDGE_PROTOCOL),
  project_id: z.string().regex(/^[a-f0-9]{64}$/),
  repo_identity: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

export const ObjectEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  object_type: z.enum(["module_snapshot", "evidence", "applicability", "receipt"]),
  object_id: HASH,
  content: z.unknown(),
}).strict();
export type ObjectEnvelope = z.infer<typeof ObjectEnvelopeSchema>;

export const SnapshotPointerSchema = z.object({
  schema_version: z.literal(1),
  transaction_id: z.string().regex(/^[a-f0-9]{64}$/),
  object_ids: z.array(HASH).max(10_000),
  committed_at: z.string().datetime({ offset: true }),
}).strict();
export type SnapshotPointer = z.infer<typeof SnapshotPointerSchema>;

export const OperationRecordSchema = z.object({
  schema_version: z.literal(1), operation_id: z.string().min(1).max(200), transaction_id: z.string().regex(/^[a-f0-9]{64}$/),
  object_ids: z.array(HASH).max(10_000),
}).strict();
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export const TransactionRecordSchema = z.object({
  schema_version: z.literal(1),
  transaction_id: z.string().regex(/^[a-f0-9]{64}$/),
  parent_transaction_id: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  operation_id: z.string().min(1).max(200),
  object_ids: z.array(HASH).max(10_000),
  pointer: SnapshotPointerSchema,
}).strict();
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;
