import { z } from "zod";

const Opaque = z.string().regex(/^[a-f0-9]{64}$/);
export const EventName = z.enum(["hook.received", "hook.finished", "scope.resolved", "context.lookup", "context.prepared", "context.emitted",
  "context.acknowledged", "workflow.bound", "tool.finished", "decision.recorded", "quality.checked", "validation.finished",
  "model.changed", "feedback.recorded", "task.transitioned", "health.checked", "telemetry.gap", "report.generated"]);
/** 字段白名单：不允许自由文本、路径、查询、命令或协议输入混进遥测。 */
export const EventAttributes = z.object({
  tool: z.enum(["plugin_status", "plugin_configure", "project_prepare", "project_scan", "project_context", "knowledge_search",
    "task_open", "task_update", "task_check", "project_feedback_record", "feedback_record", "experience_propose", "history_scan", "history_next", "history_record",
    "project_model_record", "project_model_apply"]).optional(),
  input_kind: z.enum(["request", "prd", "sdd", "combined", "unknown"]).optional(),
  query_fingerprint: Opaque.optional(), context_id: Opaque.optional(),
  candidate_count: z.number().int().min(0).max(100_000).optional(),
  selected_count: z.number().int().min(0).max(100_000).optional(),
  stale_count: z.number().int().min(0).max(100_000).optional(),
  output_bytes: z.number().int().min(0).max(1_048_576).optional(),
  attempt: z.number().int().min(1).max(10).optional(),
  cache: z.enum(["hit", "miss", "invalidated", "deduplicated"]).optional(),
  transport: z.enum(["hook", "mcp", "cli", "runner"]).optional(),
  phase: z.enum(["active", "closed", "aborted"]).optional(),
  event: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]).optional(),
  source: z.enum(["startup", "resume", "clear", "compact", "fork", "unknown"]).optional(),
  coverage: z.enum(["observed", "partial", "unknown"]).optional(),
  truncated: z.boolean().optional(),
}).strict();
export const DiagnosticEvent = z.object({
  schema_version: z.literal(1), event_id: z.uuid(), occurred_at: z.string().datetime(),
  upload_epoch: z.uuid().nullable().default(null),
  event_name: EventName, install_id: z.uuid(), trace_id: Opaque,
  project_id: Opaque.nullable(), session_id: Opaque.nullable(), task_id: Opaque.nullable(),
  runtime_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/),
  policy_version: z.literal(1), mode: z.enum(["manual", "observe", "auto"]),
  outcome: z.enum(["ok", "skipped", "degraded", "error", "incomplete"]),
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  duration_ms: z.number().min(0).max(86_400_000),
  evidence_level: z.enum(["observed", "agent_reported", "human_reviewed"]),
  attributes: EventAttributes,
}).strict();
export type TelemetryEvent = z.infer<typeof DiagnosticEvent>;
export type TelemetryAttributes = z.infer<typeof EventAttributes>;
