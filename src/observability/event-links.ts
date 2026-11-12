import type { TelemetryEvent } from "./contracts.js";

const DERIVED: Record<string, string> = { task_open: "workflow.bound", task_update: "task.transitioned", task_check: "quality.checked",
  project_context: "context.lookup", project_model_record: "model.changed", project_model_apply: "model.changed",
  project_feedback_record: "feedback.recorded", feedback_record: "feedback.recorded" };

const sameResult = (primary: TelemetryEvent, derived: TelemetryEvent) => primary.outcome !== "error"
  && derived.outcome === primary.outcome && (derived.reason_code === "OK" || derived.reason_code === primary.reason_code);
const identity = (event: TelemetryEvent) => [event.install_id, event.trace_id, event.session_id, event.project_id,
  event.task_id, event.workdir_id, event.attributes.tool, event.attributes.transport];

/** 新事件按同一调用精确关联；缺少调用ID的历史事件保留保守邻近匹配，不跨安装/会话/项目猜测。 */
export function derivedToolEvents(events: TelemetryEvent[]) {
  const linked = new Map<TelemetryEvent, TelemetryEvent>();
  const calls = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    if (!event.call_id || !event.attributes.tool || !DERIVED[event.attributes.tool]) continue;
    const key = JSON.stringify([...identity(event), event.call_id]);
    const list = calls.get(key) ?? []; list.push(event); calls.set(key, list);
  }
  for (const list of calls.values()) {
    const primary = list.filter(event => event.event_name === "tool.finished");
    const derived = list.filter(event => event.event_name === DERIVED[event.attributes.tool!]);
    // 重复主事件/派生事件意味着数据或调用身份有歧义，不能用一个ID消除多条异常。
    if (primary.length === 1 && derived.length === 1 && sameResult(primary[0]!, derived[0]!)) linked.set(derived[0]!, primary[0]!);
  }
  // 钩子收尾没有任务ID，但明确共享本次call。仅消除已知包装事件，不能消掉独立身份拒绝或失败。
  const hookCalls = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    if (!event.call_id || event.attributes.transport !== "hook" || event.attributes.event !== "PreToolUse"
      || !["hook.finished", "participation.checked"].includes(event.event_name)) continue;
    const key = JSON.stringify([event.install_id, event.trace_id, event.session_id, event.project_id, event.workdir_id, event.call_id]);
    const list = hookCalls.get(key) ?? []; list.push(event); hookCalls.set(key, list);
  }
  for (const list of hookCalls.values()) {
    const checks = list.filter(event => event.event_name === "participation.checked");
    const endings = list.filter(event => event.event_name === "hook.finished");
    if (checks.length === 1 && endings.length === 1 && endings[0]!.reason_code === "WRITE_CHECK_COMPLETED"
      && endings[0]!.outcome === checks[0]!.outcome) linked.set(endings[0]!, checks[0]!);
  }
  const pending = new Map<string, { event: TelemetryEvent | null; at: number }>();
  for (const event of [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
    if (event.call_id) continue;
    const tool = event.attributes.tool;
    if (!tool || !DERIVED[tool]) continue;
    const key = JSON.stringify(identity(event));
    const at = Date.parse(event.occurred_at), previous = pending.get(key);
    if (event.event_name === "tool.finished") {
      if (event.outcome === "error") { pending.delete(key); continue; }
      const ambiguous = previous && at - previous.at <= 1000;
      pending.set(key, { event: ambiguous ? null : event, at });
    } else if (event.event_name === DERIVED[tool] && previous?.event && at - previous.at <= 1000 && sameResult(previous.event, event)) {
      linked.set(event, previous.event); pending.delete(key);
    }
  }
  return linked;
}
