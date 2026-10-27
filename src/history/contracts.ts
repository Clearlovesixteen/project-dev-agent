import { z } from "zod";
import { RelativePathSchema, TextSchema } from "../domain/common.js";

export const HISTORY_DIR = ".project-dev/local/history";
export const PARSER_VERSION = 1;
export const HashSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const MessageSchema = z
  .object({
    id: z.string().min(1).max(120),
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(4_000),
    session: z.string().min(1).max(100),
    file: RelativePathSchema,
    line: z.number().int().positive(),
    timestamp: z.string(),
    part: z.number().int().positive(),
    parts: z.number().int().positive(),
  })
  .strict();
export type HistoryMessage = z.infer<typeof MessageSchema>;
export const BatchSchema = z
  .object({
    id: HashSchema,
    project: z.string(),
    messages: z.array(MessageSchema).min(1).max(100),
  })
  .strict();
export type HistoryBatch = z.infer<typeof BatchSchema>;
export const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    parser_version: z.number().int(),
    scan_id: HashSchema,
    project: z.string(),
    scanned_at: z.string(),
    source_home: z.string(),
    source_cursor: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    batches: z.array(HashSchema).max(1_000),
    coverage: z
      .object({
        files_discovered: z.number(),
        project_sessions: z.number(),
        internal_sessions_excluded: z.number(),
        other_projects_excluded: z.number(),
        duplicate_sessions_excluded: z.number(),
        user_messages: z.number(),
        assistant_messages: z.number(),
        attachment_messages: z.number(),
        metadata_messages_excluded: z.number(),
        duplicate_messages_excluded: z.number(),
        redactions: z.number(),
        cache_hits: z.number(),
        source_complete: z.boolean(),
      })
      .strict(),
    diagnostics: z
      .array(z.object({ code: z.string(), message: z.string() }).strict())
      .max(100),
  })
  .strict();
export type HistoryManifest = z.infer<typeof ManifestSchema>;
export const FindingSchema = z
  .object({
    topic: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    type: z.enum(["code_convention", "business_rule", "change_relation"]),
    audience: z.enum(["personal", "project"]),
    rule: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(2_000),
    paths: z.array(RelativePathSchema).max(20),
    applicable_conditions: z.array(TextSchema).min(1).max(10),
    signal: z.enum(["explicit_preference", "correction", "inferred"]),
    evidence: z
      .array(
        z
          .object({
            message_id: z.string().min(1).max(120),
            quote: z.string().trim().min(2).max(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    review_questions: z.array(TextSchema).min(1).max(10),
  })
  .strict();
export type HistoryFinding = z.infer<typeof FindingSchema>;
export const AnalysisSchema = z
  .object({
    batch_id: HashSchema,
    findings: z.array(FindingSchema).max(30),
    note: z.string().trim().min(1).max(2_000),
    analyzed_at: z.string(),
    revision: z.number().int().positive().default(1),
    revision_reason: TextSchema.optional(),
  })
  .strict();
export const HistoryScanInputSchema = z
  .object({ refresh: z.boolean().default(false) })
  .strict();
export const HistoryControlSchema = z
  .object({
    paused: z.boolean(),
    pause_reason: z.enum(["user", "budget"]),
    updated_at: z.string(),
  })
  .strict();
export const HistoryNextInputSchema = z
  .object({
    batch_id: HashSchema.optional().describe(
      "读取指定批次及其当前分析，用于核对或修订；省略时读取下一个待分析批次",
    ),
    action: z
      .enum(["next", "pause", "resume"])
      .default("next")
      .describe("读取、暂停或恢复历史分析；暂停不代表分析完成"),
    pause_reason: z
      .enum(["user", "budget"])
      .default("user")
      .describe(
        "user 表示用户暂停；budget 表示本轮分析预算用完，可在下一轮继续",
      ),
  })
  .strict();
export const HistoryRecordInputSchema = z
  .object({
    scan_id: HashSchema,
    batch_id: HashSchema,
    findings: z.array(FindingSchema).max(30),
    note: z.string().trim().min(1).max(2_000),
    expected_revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("修订已有批次时必须传当前修订号；首次保存可省略或传 0"),
    revision_reason: TextSchema.optional().describe(
      "修订或停用候选时必须说明原因；findings 是该批次修订后的完整列表",
    ),
  })
  .strict();
