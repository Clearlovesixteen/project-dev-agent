import type { TelemetryEvent } from "./contracts.js";

const DERIVED: Record<string, string> = { task_open: "workflow.bound", task_update: "task.transitioned", task_check: "quality.checked",
  project_context: "context.lookup", project_model_record: "model.changed", project_model_apply: "model.changed",
  project_feedback_record: "feedback.recorded", feedback_record: "feedback.recorded" };

/** 仅关联同安装/链路/工具/传输内紧邻的唯一主调用；并发歧义保留，不猜测归属。 */
export function derivedToolEvents(events: TelemetryEvent[]) {
  const linked = new Map<TelemetryEvent, TelemetryEvent>();
  const pending = new Map<string, { event: TelemetryEvent | null; at: number }>();
  for (const event of [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
    const tool = event.attributes.tool;
    if (!tool || !DERIVED[tool]) continue;
    const key = JSON.stringify([event.install_id, event.trace_id, event.session_id, event.project_id, event.task_id, tool, event.attributes.transport]);
    const at = Date.parse(event.occurred_at), previous = pending.get(key);
    if (event.event_name === "tool.finished") {
      if (event.outcome === "error") { pending.delete(key); continue; }
      const ambiguous = previous && at - previous.at <= 1000;
      pending.set(key, { event: ambiguous ? null : event, at });
    } else if (event.event_name === DERIVED[tool] && previous?.event && at - previous.at <= 1000
      && event.outcome === previous.event.outcome && (event.reason_code === "OK" || event.reason_code === previous.event.reason_code)) {
      linked.set(event, previous.event); pending.delete(key);
    }
  }
  return linked;
}
