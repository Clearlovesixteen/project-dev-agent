import { createHash } from "node:crypto";
import type { TelemetryEvent } from "./contracts.js";

const WINDOW_MS = 5 * 60_000, MAX_CHAINS = 200, MAX_RECENT = 20, MAX_SIGNALS = 200;
const PRIMARY = new Set(["tool.finished", "participation.checked", "decision.recorded", "hook.finished", "validation.finished", "telemetry.gap"]);
const rank = (event: TelemetryEvent) => event.event_name === "tool.finished" ? 5 : event.event_name === "participation.checked" ? 4
  : event.event_name === "decision.recorded" ? 3 : event.event_name === "validation.finished" ? 2 : 1;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** trace_id只标识轮次；组合安装、会话及项目后才能作为报告唯一键。 */
export const diagnosticTraceKey = (event: TelemetryEvent) => digest([event.install_id, event.trace_id, event.session_id, event.project_id, event.project_id ? null : event.workdir_id]);
const chainKey = (event: TelemetryEvent) => digest([event.install_id, event.session_id ?? `trace:${event.trace_id}`,
  event.project_id ? `project:${event.project_id}` : event.workdir_id ? `workdir:${event.workdir_id}` : `unattributed:${event.trace_id}`]);
const denied = (event: TelemetryEvent) => event.context?.decision === "deny"
  || event.event_name === "participation.checked" && event.outcome === "incomplete";
const progress = (event: TelemetryEvent) => event.outcome === "ok" && (event.reason_code === "WRITE_READY"
  || ["TASK_OPENED", "TASK_CLOSED", "TASK_SUSPENDED", "TASK_ABORTED"].includes(event.reason_code));
const stateKey = (event: TelemetryEvent) => JSON.stringify([event.runtime_version, event.task_id, event.reason_code,
  event.context?.stage, event.context?.command_family, event.context?.task_state, event.context?.task_kind,
  event.context?.merge_state, event.context?.context_state, event.context?.basis_state, event.context?.target_scope,
  event.context?.native_tool, event.context?.command_class, event.context?.command_shape, event.context?.scope_state,
  event.context?.conflict_count, event.context?.target_count, event.context?.required_action]);

type SignalKind = "repeated_guard" | "merge_recovery_cycle" | "enrollment_pending" | "read_classification_review";
export interface DiagnosticSignal {
  kind: SignalKind; label: string; assessment: "needs_review"; chain_key: string; event_ids: string[];
  trace_keys: string[]; occurrences: number; first_at: string; last_at: string; progress_observed: boolean;
}
function signal(kind: SignalKind, label: string, chain_key: string, events: TelemetryEvent[]): DiagnosticSignal {
  return { kind, label, assessment: "needs_review", chain_key, event_ids: events.map(event => event.event_id),
    trace_keys: [...new Set(events.map(diagnosticTraceKey))], occurrences: events.length,
    first_at: events[0]!.occurred_at, last_at: events.at(-1)!.occurred_at, progress_observed: false };
}

/** 只关联实际观测的终态；工作目录摘要不能替代真实Git绑定，缺身份的旧记录不跨轮拼接。 */
export function analyzeIncidents(events: TelemetryEvent[], derived: Map<TelemetryEvent, TelemetryEvent>) {
  const buckets = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    if (!PRIMARY.has(event.event_name) || derived.has(event)) continue;
    // 成功收尾与更详细的门禁事件重复，不拿它打断“失败→补准备→失败”的观察链。
    if (event.event_name === "hook.finished" && event.outcome === "ok" && !event.context?.decision) continue;
    const key = chainKey(event), list = buckets.get(key) ?? []; list.push(event); buckets.set(key, list);
  }
  let signalCount = 0;
  const signals: DiagnosticSignal[] = [];
  const chains = [...buckets.entries()].map(([key, raw]) => {
    // 同一调用可能同时有门禁和hook收尾，保留最接近实际判断的主事件，不能重复算一次拒绝。
    const calls = new Map<string, TelemetryEvent>(); const list: TelemetryEvent[] = [];
    for (const event of raw) {
      if (!event.call_id) { list.push(event); continue; }
      const prior = calls.get(event.call_id);
      if (!prior || rank(event) > rank(prior)) calls.set(event.call_id, event);
    }
    list.push(...calls.values()); list.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const local: DiagnosticSignal[] = [];
    const repetitions = new Map<string, { first: TelemetryEvent; issue?: DiagnosticSignal }>();
    const pendingProgress = new Set<DiagnosticSignal>(), pendingEnrollment = new Set<DiagnosticSignal>();
    let mergeOpen: TelemetryEvent | undefined;
    const append = (value: DiagnosticSignal) => {
      local.push(value);
      if (["repeated_guard", "merge_recovery_cycle"].includes(value.kind)) pendingProgress.add(value);
      if (value.kind === "enrollment_pending") pendingEnrollment.add(value);
    };
    for (const event of list) {
      if (progress(event)) {
        repetitions.clear(); mergeOpen = undefined;
        for (const issue of pendingProgress) issue.progress_observed = true;
        pendingProgress.clear();
      }
      if (event.attributes.tool === "project_prepare" && event.outcome === "ok" && event.context?.scope_state === "enrolled") {
        for (const issue of pendingEnrollment) issue.progress_observed = true;
        pendingEnrollment.clear();
      }
      if (event.attributes.tool === "task_open" && event.reason_code === "UNMERGED_CHANGES") mergeOpen = event;
      if (mergeOpen && Date.parse(event.occurred_at) - Date.parse(mergeOpen.occurred_at) > WINDOW_MS) mergeOpen = undefined;
      if (mergeOpen && denied(event) && event.reason_code === "TASK_BINDING_REQUIRED"
        && (["git_restore", "git_add"].includes(event.context?.command_family ?? "") || ["patch", "edit", "write"].includes(event.context?.native_tool ?? ""))) {
        append(signal("merge_recovery_cycle", "疑似冲突恢复双向阻塞：建任务遇冲突，修复又要求先建任务", key, [mergeOpen, event])); mergeOpen = undefined;
      }
      if (denied(event)) {
        const signature = stateKey(event), previous = repetitions.get(signature);
        if (!previous || Date.parse(event.occurred_at) - Date.parse(previous.first.occurred_at) > WINDOW_MS) {
          repetitions.set(signature, { first: event });
        } else {
          if (!previous.issue) {
            previous.issue = signal("repeated_guard", "同一观测状态下反复被拦，请核对恢复动作是否有效", key, [previous.first, event]);
            append(previous.issue);
          } else {
            const issue = previous.issue;
            issue.occurrences++; issue.last_at = event.occurred_at;
            issue.event_ids = [...issue.event_ids, event.event_id].slice(-MAX_RECENT);
            issue.trace_keys = [...new Set([...issue.trace_keys, diagnosticTraceKey(event)])].slice(-MAX_RECENT);
          }
        }
      }
      if (["PROJECT_NOT_ENROLLED", "PROJECT_OUTSIDE_WORKSPACE"].includes(event.reason_code)
        || event.reason_code === "PROJECT_SETUP_REQUIRED" && ["not_enrolled", "outside"].includes(event.context?.scope_state ?? ""))
        append(signal("enrollment_pending", "观察到项目未接入或范围拒绝，需核对后续准备结果", key, [event]));
      const readFamily = ["number_lines", "text_read", "search", "git_read"].includes(event.context?.command_family ?? "");
      if (denied(event) && (event.context?.command_class === "read_only"
        || readFamily && event.context?.command_class === "unknown" && ["single", "chain", "pipeline"].includes(event.context?.command_shape ?? "")))
        append(signal("read_classification_review", "读取能力进入拒绝流程，需复核命令分类及实际边界", key, [event]));
    }
    signalCount += local.length; signals.push(...local);
    const recent = list.slice(-MAX_RECENT), last = list.at(-1)!;
    return { chain_key: key, install_id: last.install_id, session_id: last.session_id, project_id: last.project_id,
      workdir_id: last.project_id ? null : last.workdir_id ?? null,
      grouping: last.project_id ? "project" as const : last.workdir_id ? "workdir_only" as const : "unattributed_turn" as const,
      event_count: list.length, events_truncated: list.length > recent.length, signal_count: local.length,
      events: recent.map(event => ({ event_id: event.event_id, trace_key: diagnosticTraceKey(event), trace_id: event.trace_id,
        at: event.occurred_at, name: event.event_name, outcome: event.outcome, reason: event.reason_code,
        tool: event.attributes.tool ?? null, call_id: event.call_id ?? null, operation_id: event.operation_id ?? null,
        task_id: event.task_id, context: event.context ?? null })) };
  }).sort((a, b) => Number(b.signal_count > 0) - Number(a.signal_count > 0)
    || b.events.at(-1)!.at.localeCompare(a.events.at(-1)!.at));
  signals.sort((a, b) => Number(a.progress_observed) - Number(b.progress_observed) || b.last_at.localeCompare(a.last_at));
  return { window_ms: WINDOW_MS, total_chains: chains.length, chains: chains.slice(0, MAX_CHAINS), chains_truncated: chains.length > MAX_CHAINS,
    total_signals: signalCount, signals: signals.slice(0, MAX_SIGNALS), signals_truncated: signalCount > MAX_SIGNALS,
    limitation: "仅是已观测事件的排查线索，不代表确定缺陷、用户意图或插件整体效果。循环观察窗口为5分钟；已观测推进只说明后续动作发生，不等于业务通过。无会话身份不跨轮串联，工作目录摘要不冒充项目绑定。缺失/截断/旧版上下文可能掩盖前后步骤。" };
}
