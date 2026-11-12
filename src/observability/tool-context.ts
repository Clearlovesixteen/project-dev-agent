import { DiagnosticContext } from "./diagnostic-context.js";
import type { InteractionContext } from "../workflow/interaction.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => Array.isArray(value) ? Math.min(500, value.length) : undefined;
const phases = ["active", "suspended", "closed", "aborted"] as const;

/** 只抽取 SDK 已校验输入的结构事实；需求、引用、路径、原始命令永不进入快照。 */
export function inputDiagnosticContext(tool: string, raw: unknown): DiagnosticContext {
  const input = object(raw);
  const stage = tool === "project_prepare" || tool.startsWith("plugin_") ? "scope" : tool.startsWith("task_") ? "task" : "context";
  return { version: 1, stage,
    ...(tool === "task_open" ? { task_kind: input.task_kind === "merge_recovery" ? "merge_recovery" as const : "development" as const,
      recovery_source: typeof input.resolution_source === "string" ? "selected" as const : "not_selected" as const } : {}),
  };
}

/** 复用领域服务的结果，不补读 Git/任务文件；没有观测到的状态保持缺失。 */
export function toolDiagnosticContext(tool: string, input: DiagnosticContext | undefined,
  result: { outcome?: string; code?: string; data?: Record<string, unknown> }, interaction?: InteractionContext): DiagnosticContext {
  const value: DiagnosticContext = { ...inputDiagnosticContext(tool, {}), ...input };
  const data = object(result.data);
  // 模型、经验等记录也有 id；只有任务工具返回的数据才具有任务语义。
  const task = tool === "task_check" ? object(data.recorded_task)
    : ["task_open", "task_update"].includes(tool) ? data : {};
  const owner = object(task.owner), baseline = object(task.workspace_baseline), recovery = object(baseline.merge_recovery);
  if (phases.includes(task.phase as typeof phases[number])) value.task_phase = task.phase as typeof phases[number];
  if (typeof task.id === "string") {
    value.task_kind = recovery.version === 1 ? "merge_recovery" : "development";
    value.task_state = typeof owner.session_id !== "string" ? "unowned" : !interaction ? undefined
      : owner.session_id === interaction.session_id && (owner.actor_id ?? "main") === (interaction.actor_id ?? "main") ? "owned" : "other_owner";
    if (value.task_state === undefined) delete value.task_state;
    const planned = count(task.change_items); if (planned !== undefined) value.planned_count = planned;
    if (recovery.version === 1) {
      const conflicts = count(recovery.conflicts); if (conflicts !== undefined) value.initial_conflict_count = conflicts;
      value.recovery_source = recovery.source ? "selected" : "not_selected";
    }
  }
  if (tool === "project_prepare") {
    if (object(data.plugin_setup).action === "would_initialize") value.scope_state = "not_enrolled";
    else if (typeof data.project === "string" && typeof data.state_ignored === "boolean") value.scope_state = "enrolled";
    if (data.unmerged === true) value.merge_state = "unmerged";
    if (data.active_task === null) value.task_state = "missing";
    const active = object(data.active_task);
    if (active.ownership === "another_session") value.task_state = "other_owner";
  }
  const lookup = ["not_scanned", "paths_excluded", "needs_rescan", "needs_review", "indexed", "partial"] as const;
  if (tool === "project_context" && lookup.includes(data.state as typeof lookup[number])) {
    value.lookup_state = data.state as typeof lookup[number];
    // 与参与状态的准备判定一致；ready 不代表模型已复核，保留查询状态单独说明。
    value.context_state = ["not_scanned", "needs_rescan"].includes(value.lookup_state) ? "not_ready" : "ready";
  }
  const merge = object(data.merge_recovery);
  if (merge.state === "committed" || merge.state === "resolved_uncommitted") value.merge_state = merge.state;
  if (["projects", "workspace"].includes(String(data.scope_mode))) value.scope_mode = data.scope_mode as "projects" | "workspace";
  if (data.scope_mode === "legacy_pending_migration") value.scope_mode = "legacy";
  if (data.scope_mode === "unconfigured") value.scope_mode = "unconfigured";
  if (Array.isArray(data.projects)) value.enrolled_project_count = Math.min(1000, data.projects.length);
  if (result.outcome === "error") value.decision = "error";
  else if (result.outcome === "incomplete") value.decision = "incomplete";
  // 错误含义由服务固定错误码提供；不解析或上传任何自由文本 message。
  switch (result.code) {
    case "PROJECT_NOT_ENROLLED": case "PLUGIN_NOT_CONFIGURED":
      value.scope_state = "not_enrolled"; value.required_action = "prepare"; delete value.task_state; break;
    case "PROJECT_OUTSIDE_WORKSPACE": value.scope_state = "outside"; value.required_action = "review_scope"; break;
    case "WORKSPACE_CHANGED": value.scope_state = "changed"; value.required_action = "review_scope"; break;
    case "NO_ACTIVE_TASK": value.task_state = "missing"; value.required_action = "open_task"; break;
    case "UNMERGED_CHANGES": value.merge_state = "unmerged";
      value.required_action = value.task_kind === "merge_recovery" ? "resolve_conflicts" : "open_merge_recovery"; break;
    case "MERGE_RECOVERY_NOT_STAGED": value.required_action = "stage_conflicts"; break;
    case "MERGE_MARKERS_REMAIN": value.required_action = "resolve_conflicts"; break;
    case "MERGE_RECOVERY_CHANGED": value.merge_state = "changed"; value.required_action = "review_source"; break;
    case "MERGE_RECOVERY_SOURCE_MISMATCH": value.recovery_source = "mismatch"; value.required_action = "review_source"; break;
    case "TASK_SESSION_MISMATCH": value.task_state = "other_owner"; value.required_action = "ask_owner"; break;
    case "IMPLEMENTATION_BASIS_REQUIRED": value.basis_state = "missing"; value.required_action = "review_basis"; break;
  }
  // 只有成功的 prepare 才能说明已接入；异常不把初始推测当成已观测成功。
  if (tool === "project_prepare" && result.outcome === "error" && value.scope_state === "enrolled") delete value.scope_state;
  const checked = DiagnosticContext.safeParse(value);
  return checked.success ? checked.data : { version: 1 };
}
