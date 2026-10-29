import { DiagnosticWriter } from "./writer.js";
import type { TelemetryEvent } from "./contracts.js";
import { DiagnosticEvent } from "./contracts.js";

const LIMITS = ["只覆盖本插件实际收到的钩子、进入 handler 的工具及验证器；宿主未加载钩子、SDK 提前拒绝参数或绕过插件的操作不在统计内。",
  "注入回执只说明 ID 匹配；agent_reported 不等于真实采纳、代码合规或业务正确。",
  "不包含源码、需求、对话、查询及真实路径。基础诊断能定位链路、版本和错误码，不能仅据它判断语义遗漏。",
  "本地每日最多约 1 MiB，保留 30 天；截断、损坏或过期会影响覆盖，未观测到问题不能当作没有问题。"];
export function summarizeEvents(events: TelemetryEvent[], coverage: { invalid: number; truncated: boolean }) {
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of events) { const list = groups.get(event.trace_id) ?? []; list.push(event); groups.set(event.trace_id, list); }
  const taskTraces = new Map<string, Set<string>>();
  for (const event of events) if (event.task_id) {
    const related = taskTraces.get(event.task_id) ?? new Set<string>(); related.add(event.trace_id); taskTraces.set(event.task_id, related);
  }
  const failures = events.filter(event => ["error", "degraded", "incomplete"].includes(event.outcome));
  const clusters = new Map<string, TelemetryEvent[]>();
  for (const event of failures) {
    const key = `${event.runtime_version}/${event.event_name}/${event.reason_code}`;
    const list = clusters.get(key) ?? []; list.push(event); clusters.set(key, list);
  }
  const durations = events.filter(event => event.event_name === "hook.finished").map(event => event.duration_ms).sort((a, b) => a - b);
  const quantile = (ratio: number) => durations.length ? durations[Math.max(0, Math.ceil(durations.length * ratio) - 1)]! : null;
  const count = (name: string) => events.filter(event => event.event_name === name).length;
  return { schema_version: 1, generated_at: new Date().toISOString(), sample_events: events.length,
    observed_from: events.map(event => event.occurred_at).sort()[0] ?? null,
    observed_to: events.map(event => event.occurred_at).sort().at(-1) ?? null,
    coverage, counts: { hooks_received: count("hook.received"), hooks_finished: count("hook.finished"), contexts_emitted: count("context.emitted"),
      matched_receipts: events.filter(event => event.event_name === "context.acknowledged" && event.reason_code === "RECEIPT_MATCHED").length,
      workflows_bound: count("workflow.bound"), validations: count("validation.finished"), feedback_recorded: count("feedback.recorded") },
    hook_duration_ms: { p50: quantile(0.5), p95: quantile(0.95) },
    issues: [...clusters.entries()].map(([key, list]) => ({ key, occurrences: list.length,
      classification: list.every(event => event.outcome === "incomplete") ? "pending_or_review_signal" : "operational_signal",
      affected_installs: new Set(list.map(event => event.install_id)).size, versions: [...new Set(list.map(event => event.runtime_version))],
      evidence_level: [...new Set(list.map(event => event.evidence_level))], trace_ids: [...new Set(list.map(event => event.trace_id))].slice(0, 10) }))
      .sort((a, b) => b.occurrences - a.occurrences),
    traces: [...groups.entries()].sort((a, b) => Number(b[1].some(event => ["error", "degraded", "incomplete"].includes(event.outcome)))
      - Number(a[1].some(event => ["error", "degraded", "incomplete"].includes(event.outcome)))
      || b[1].map(event => event.occurred_at).sort().at(-1)!.localeCompare(a[1].map(event => event.occurred_at).sort().at(-1)!))
      .slice(0, 200).map(([trace_id, list]) => ({ trace_id,
      related_trace_ids: [...new Set(list.flatMap(event => event.task_id ? [...taskTraces.get(event.task_id) ?? []] : []))].filter(id => id !== trace_id).slice(0, 10),
      events: list.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map(event => ({ event_id: event.event_id, at: event.occurred_at,
        name: event.event_name, outcome: event.outcome, reason: event.reason_code, duration_ms: event.duration_ms,
        version: event.runtime_version, evidence: event.evidence_level, task_id: event.task_id, project_id: event.project_id,
        session_id: event.session_id, attributes: event.attributes })) })),
    traces_truncated: groups.size > 200, limitations: LIMITS };
}

export async function developerInsights(options: { home?: string; days?: number; trace?: string } = {}) {
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("诊断范围须为 1–30 天");
  if (options.trace && !/^[a-f0-9]{64}$/.test(options.trace)) throw new Error("链路 ID 须为 64 位摘要");
  const read = await new DiagnosticWriter(options.home).read(new Date(Date.now() - days * 86_400_000).toISOString());
  const events = options.trace ? read.events.filter(event => event.trace_id === options.trace) : read.events;
  return summarizeEvents(events, { invalid: read.invalid, truncated: read.truncated });
}

/** 维护者可导入自己账户导出的 D1 元数据，复用同一报告口径，不开放远程读取 API。 */
export function importedInsights(raw: unknown, days = 7, trace?: string) {
  if (!Number.isInteger(days) || days < 1 || days > 30 || trace && !/^[a-f0-9]{64}$/.test(trace)) throw new Error("诊断范围或链路标识无效");
  let values: unknown[];
  if (Array.isArray(raw)) values = raw.flatMap(item => item && typeof item === "object" && "results" in item && Array.isArray(item.results) ? item.results : [item]);
  else if (raw && typeof raw === "object" && "events" in raw && Array.isArray(raw.events)) values = raw.events;
  else throw new Error("导入文件需要是事件数组、events 对象或 Wrangler D1 JSON 导出");
  const truncated = values.length > 20_000, events: TelemetryEvent[] = []; let invalid = 0;
  const since = Date.now() - days * 86_400_000;
  for (let value of values.slice(0, 20_000)) {
    try {
      if (value && typeof value === "object" && "payload" in value && typeof value.payload === "string") value = JSON.parse(value.payload);
      const event = DiagnosticEvent.safeParse(value);
      if (!event.success) { invalid++; continue; }
      if (Date.parse(event.data.occurred_at) >= since && (!trace || event.data.trace_id === trace)) events.push(event.data);
    } catch { invalid++; }
  }
  return summarizeEvents([...new Map(events.map(event => [`${event.install_id}:${event.event_id}`, event])).values()], { invalid, truncated });
}

const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
/** 维护者私用静态报告，无外链脚本、无网络、无用户打分或新工作流。 */
export function renderInsights(report: ReturnType<typeof summarizeEvents>) {
  const traceIds = new Set(report.traces.map(trace => trace.trace_id));
  const link = (id: string) => traceIds.has(id) ? `<a href="#${id}">${escape(id.slice(0, 12))}</a>` : `<code>${escape(id.slice(0, 12))}</code>`;
  const labels: Record<string, string> = { hooks_received: "钩子进入", hooks_finished: "处理结束", contexts_emitted: "上下文已输出", matched_receipts: "匹配回执", workflows_bound: "新任务绑定", validations: "真实验证完成", feedback_recorded: "纠正记录" };
  const issues = report.issues.map(issue => `<tr><td>${escape(issue.key)}</td><td>${issue.occurrences}</td><td>${issue.affected_installs}</td><td>${issue.trace_ids.map(link).join(" ")}</td></tr>`).join("");
  const traces = report.traces.map(trace => `<details id="${trace.trace_id}"><summary>${escape(trace.trace_id)}</summary><p>同任务其他链路：${trace.related_trace_ids.map(link).join(" · ") || "无可关联样本"}</p><table><thead><tr><th>时间</th><th>事件</th><th>结果 / 错误码</th><th>毫秒</th><th>证据</th></tr></thead><tbody>${trace.events.map(event => `<tr><td>${escape(event.at)}</td><td>${escape(event.name)}</td><td>${escape(event.outcome)} / ${escape(event.reason)}</td><td>${Math.round(event.duration_ms)}</td><td>${escape(event.evidence)}</td></tr>`).join("")}</tbody></table></details>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><title>Project Dev Agent 开发者诊断</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:15px/1.8 system-ui;color:#20312b;background:#f7f8f4}h1{font-size:30px}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;border-bottom:1px solid #dde3dd;padding:10px;overflow-wrap:anywhere}a{color:#17664e}details{margin:12px 0}summary{cursor:pointer;overflow-wrap:anywhere}.stats{display:flex;flex-wrap:wrap;gap:14px}.card{background:white;border:1px solid #dde3dd;padding:16px;border-radius:9px}.notice{padding:18px;background:#fff4dd}code{overflow-wrap:anywhere}@media(max-width:600px){body{margin:20px auto}table{font-size:12px}td{padding:5px}}</style><h1>插件开发者诊断</h1><p>样本 ${report.sample_events} 条 · ${escape(report.observed_from)} 至 ${escape(report.observed_to)}</p><p class="notice">仅供插件维护者排查和复测。损坏事件 ${report.coverage.invalid} 条；读取截断：${report.coverage.truncated ? "是" : "否"}。没有数据表示尚无可分析样本。</p><div class="stats">${Object.entries(report.counts).map(([key, value]) => `<div class="card"><b>${value}</b><br>${escape(labels[key] ?? key)}</div>`).join("")}<div class="card">钩子 p50 / p95<br>${escape(report.hook_duration_ms.p50)} / ${escape(report.hook_duration_ms.p95)} ms</div></div><h2>问题聚类</h2><table><thead><tr><th>版本 / 事件 / 错误码</th><th>次数</th><th>安装数</th><th>样本链路</th></tr></thead><tbody>${issues || '<tr><td colspan="4">本次样本没有观测到异常事件。</td></tr>'}</tbody></table><h2>链路明细</h2>${traces || '<p>尚无链路。</p>'}<h2>覆盖边界</h2><ul>${report.limitations.map(item => `<li>${escape(item)}</li>`).join("")}</ul></html>`;
}
