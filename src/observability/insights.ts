import { DiagnosticWriter } from "./writer.js";
import type { TelemetryEvent } from "./contracts.js";
import { DiagnosticEvent } from "./contracts.js";
import { derivedToolEvents } from "./event-links.js";
import { analyzeIncidents, diagnosticTraceKey } from "./incident-analysis.js";
import { contextDescription } from "./context-labels.js";

// 历史事件可凭明确task_id保留同任务链接；缺会话身份仍不进入跨轮故障推断。
const taskTraceKey = (event: TelemetryEvent) => JSON.stringify([event.install_id, event.session_id,
  event.project_id ? `project:${event.project_id}` : event.workdir_id ? `workdir:${event.workdir_id}` : `trace:${event.trace_id}`, event.task_id]);
const LIMITS = ["只覆盖本插件实际收到的钩子、进入 handler 的工具及验证器；宿主未加载钩子、SDK 提前拒绝参数或绕过插件的操作不在统计内。",
  "注入回执只说明 ID 匹配；agent_reported 不等于真实采纳、代码合规或业务正确。",
  "默认结构化事件不包含源码、需求、对话、查询及真实路径。结构化上下文和调用链仍不能独立判断业务语义。",
  "安装标识可能包含维护自测，不能当作团队人数。仅在主调用关联明确时排除重复派生信号；保护性拒绝与待复核不必然是插件缺陷。",
  "本地每日最多约 1 MiB，保留 30 天；截断、损坏或过期会影响覆盖，未观测到问题不能当作没有问题。"];
export function summarizeEvents(events: TelemetryEvent[], coverage: { invalid: number; truncated: boolean }) {
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of events) { const key = diagnosticTraceKey(event), list = groups.get(key) ?? []; list.push(event); groups.set(key, list); }
  const taskTraces = new Map<string, Set<string>>();
  for (const event of events) if (event.task_id) {
    const key = taskTraceKey(event);
    const related = taskTraces.get(key) ?? new Set<string>(); related.add(diagnosticTraceKey(event)); taskTraces.set(key, related);
  }
  const derived = derivedToolEvents(events);
  const incidentAnalysis = analyzeIncidents(events, derived);
  const rawFailures = events.filter(event => ["error", "degraded", "incomplete"].includes(event.outcome));
  const failures = rawFailures.filter(event => !derived.has(event));
  const clusters = new Map<string, TelemetryEvent[]>();
  for (const event of failures) {
    const key = `${event.runtime_version}/${event.event_name}/${event.reason_code}`;
    const list = clusters.get(key) ?? []; list.push(event); clusters.set(key, list);
  }
  const durations = events.filter(event => event.event_name === "hook.finished").map(event => event.duration_ms).sort((a, b) => a - b);
  const quantile = (ratio: number) => durations.length ? durations[Math.max(0, Math.ceil(durations.length * ratio) - 1)]! : null;
  const count = (name: string) => events.filter(event => event.event_name === name).length;
  const reasonCount = (reason: string) => events.filter(event => event.reason_code === reason).length;
  return { schema_version: 1, generated_at: new Date().toISOString(), sample_events: events.length,
    observed_from: events.map(event => event.occurred_at).sort()[0] ?? null,
    observed_to: events.map(event => event.occurred_at).sort().at(-1) ?? null,
    coverage, signal_coverage: { raw_events: rawFailures.length, primary_signals: failures.length, excluded_derived_events: rawFailures.length - failures.length },
    total_traces: groups.size, install_ids: new Set(events.map(event => event.install_id)).size,
    counts: { hooks_received: count("hook.received"), hooks_finished: count("hook.finished"), contexts_emitted: count("context.emitted"),
      matched_receipts: events.filter(event => event.event_name === "context.acknowledged" && event.reason_code === "RECEIPT_MATCHED").length,
      workflows_bound: count("workflow.bound"), validations: count("validation.finished"), feedback_recorded: count("feedback.recorded") },
    participation: {
      command_classification: Object.fromEntries(["read_only", "write", "unknown", "management"].map(kind => [kind,
        events.filter(event => event.event_name === "decision.recorded" && event.reason_code.startsWith(`COMMAND_${kind.toUpperCase()}_`)).length])),
      migration_notices: reasonCount("ACTIVATION_MIGRATION_REQUIRED"), automatic_upgrades: reasonCount("MANUAL_UPGRADED_TO_AUTO"),
      upgrade_pending: reasonCount("ACTIVATION_UPGRADE_PENDING"), manual_skips: reasonCount("MANUAL_MODE"), observe_skips: reasonCount("OBSERVE_ONLY"),
      scope_not_ready: reasonCount("PROJECT_OUTSIDE_WORKSPACE"), enrollment_required: reasonCount("PROJECT_NOT_ENROLLED"), setup_required: reasonCount("PROJECT_SETUP_REQUIRED"),
      writes_ready: reasonCount("WRITE_READY"), write_tools_completed: reasonCount("WRITE_TOOL_COMPLETED"),
      unobserved_write_guards: reasonCount("WRITE_GUARD_NOT_OBSERVED"), checks_required: reasonCount("PARTICIPATION_CHECK_REQUIRED"),
      lifecycle: Object.fromEntries(["active", "suspended", "closed", "aborted"].map(phase => [phase,
        events.filter(event => event.event_name === "task.transitioned" && event.attributes.phase === phase).length])),
      unknown_transition_phases: events.filter(event => event.event_name === "task.transitioned" && !event.attributes.phase).length,
      limitation: "按实际事件计数，不是用户数、需求数或覆盖率；终端分类仅覆盖已记录的复杂读取、修改和未知命令，不是终端总量；历史 manual 事件无法区分主动关闭与旧默认；新版单独记录自动迁移成功与未完成。钩子未运行的轮次没有总量，不能据此计算自动参与率。",
    },
    incident_analysis: incidentAnalysis,
    context_coverage: { with_context: events.filter(event => !!event.context).length, without_context: events.filter(event => !event.context).length,
      with_call_id: events.filter(event => !!event.call_id).length, without_call_id: events.filter(event => !event.call_id).length },
    hook_duration_ms: { p50: quantile(0.5), p95: quantile(0.95) },
    total_issue_clusters: clusters.size, issue_clusters_truncated: clusters.size > 200,
    issues: [...clusters.entries()].map(([key, list]) => ({ key, occurrences: list.length,
      classification: list.every(event => event.outcome === "incomplete") ? "pending_or_review_signal" : "operational_signal",
      affected_installs: new Set(list.map(event => event.install_id)).size, versions: [...new Set(list.map(event => event.runtime_version))],
      evidence_level: [...new Set(list.map(event => event.evidence_level))], trace_keys: [...new Set(list.map(diagnosticTraceKey))].slice(0, 10), trace_ids: [...new Set(list.map(event => event.trace_id))].slice(0, 10) }))
      .sort((a, b) => b.occurrences - a.occurrences).slice(0, 200),
    traces: [...groups.entries()].sort((a, b) => Number(b[1].some(event => ["error", "degraded", "incomplete"].includes(event.outcome)))
      - Number(a[1].some(event => ["error", "degraded", "incomplete"].includes(event.outcome)))
      || b[1].map(event => event.occurred_at).sort().at(-1)!.localeCompare(a[1].map(event => event.occurred_at).sort().at(-1)!))
      .slice(0, 200).map(([trace_key, list]) => {
        const related_trace_keys = [...new Set(list.flatMap(event => event.task_id ? [...taskTraces.get(taskTraceKey(event)) ?? []] : []))]
          .filter(id => id !== trace_key).slice(0, 10);
        const chronological = [...list].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
        return { trace_key, trace_id: list[0]!.trace_id, install_id: list[0]!.install_id, session_id: list[0]!.session_id,
          project_id: list[0]!.project_id, related_trace_keys,
          related_trace_ids: [...new Set(related_trace_keys.map(key => groups.get(key)![0]!.trace_id))],
          event_count: chronological.length, events_truncated: chronological.length > 100,
          events: chronological.slice(-100).map(event => ({ event_id: event.event_id, at: event.occurred_at,
            name: event.event_name, outcome: event.outcome, reason: event.reason_code, duration_ms: event.duration_ms,
            version: event.runtime_version, evidence: event.evidence_level, task_id: event.task_id, project_id: event.project_id,
            call_id: event.call_id ?? null, operation_id: event.operation_id ?? null, workdir_id: event.workdir_id ?? null, context: event.context ?? null,
            ...(derived.has(event) ? { related_tool_event_id: derived.get(event)!.event_id, related_tool_reason: derived.get(event)!.reason_code } : {}),
            session_id: event.session_id, attributes: event.attributes })) };
      }),
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
  const traceIds = new Set(report.traces.map(trace => trace.trace_key));
  const link = (id: string) => traceIds.has(id) ? `<a href="#${id}">${escape(id.slice(0, 12))}</a>` : `<code>${escape(id.slice(0, 12))}</code>`;
  const labels: Record<string, string> = { hooks_received: "钩子进入", hooks_finished: "处理结束", contexts_emitted: "上下文已输出", matched_receipts: "匹配回执", workflows_bound: "新任务绑定", validations: "真实验证完成", feedback_recorded: "纠正记录" };
  const issues = report.issues.map(issue => `<tr><td>${escape(issue.key)}</td><td>${issue.occurrences}</td><td>${issue.affected_installs}</td><td>${issue.trace_keys.map(link).join(" ")}</td></tr>`).join("");
  const participation = report.participation;
  const participationHtml = `<h2>自动参与与检查缺口</h2><p>${escape(participation.limitation)}</p><table><thead><tr><th>迁移待选择</th><th>manual / observe 跳过</th><th>范围外 / 未接入 / 未初始化</th><th>修改准备通过 / 工具返回</th><th>未匹配前检查 / 待验收</th></tr></thead><tbody><tr><td>${participation.migration_notices}</td><td>${participation.manual_skips} / ${participation.observe_skips}</td><td>${participation.scope_not_ready} / ${participation.enrollment_required} / ${participation.setup_required}</td><td>${participation.writes_ready} / ${participation.write_tools_completed}</td><td>${participation.unobserved_write_guards} / ${participation.checks_required}</td></tr></tbody></table><p>任务阶段事件：${escape(JSON.stringify(participation.lifecycle))}；旧事件缺少阶段：${participation.unknown_transition_phases}。阶段未知不能补猜为关闭。</p>`;
  const chains = report.incident_analysis.chains;
  const incidents = `<h2>恢复链路排查</h2><p>${escape(report.incident_analysis.limitation)}</p><p>结构化上下文 ${report.context_coverage.with_context} 条，缺失 ${report.context_coverage.without_context} 条；调用ID缺失 ${report.context_coverage.without_call_id} 条。共 ${report.incident_analysis.total_signals} 条排查线索，展示 ${report.incident_analysis.signals.length} 条${report.incident_analysis.signals_truncated ? "（截断）" : ""}；调用链 ${report.incident_analysis.total_chains} 组，展示 ${chains.length} 组${report.incident_analysis.chains_truncated ? "（截断）" : ""}。</p><table><thead><tr><th>排查线索（待复核）</th><th>观测次数</th><th>后续推进</th><th>证据</th></tr></thead><tbody>${report.incident_analysis.signals.map(item => `<tr><td>${escape(item.label)}</td><td>${item.occurrences}</td><td>${item.progress_observed ? "已观察到后续推进，仍需核对结果" : "未观察到，不能据此断言仍失败"}</td><td>${item.trace_keys.map(link).join(" ")}</td></tr>`).join("") || '<tr><td colspan="4">本次样本没有形成对应排查线索，不代表插件不存在问题。</td></tr>'}</tbody></table>${chains.map(chain => `<details><summary>最近调用 · 安装 ${escape(chain.install_id.slice(0, 8))} · 会话 ${escape(chain.session_id?.slice(0, 8) ?? "未知")} · ${chain.grouping === "project" ? "项目维度" : chain.grouping === "workdir_only" ? "仅工作目录，项目未知" : "归属未知，仅当前轮次"} · ${chain.events.length} / ${chain.event_count} 条${chain.events_truncated ? "（仅展示最近20条）" : ""}</summary><table><thead><tr><th>时间 / 轮次</th><th>动作 / 结果</th><th>上下文</th></tr></thead><tbody>${chain.events.map(event => `<tr><td>${escape(event.at)}<br>${link(event.trace_key)}</td><td>${escape(event.tool ?? event.name)}<br>${escape(event.reason)}</td><td>${escape(contextDescription(event.context))}<br>调用 ${escape(event.call_id?.slice(0, 12) ?? "未知")} · 操作 ${escape(event.operation_id?.slice(0, 12) ?? "未知")}</td></tr>`).join("")}</tbody></table></details>`).join("")}`;
  const traces = report.traces.map(trace => `<details id="${trace.trace_key}"><summary>轮次 ${escape(trace.trace_id.slice(0, 16))} · 安装 ${escape(trace.install_id.slice(0, 8))} · ${trace.events.length} / ${trace.event_count} 条${trace.events_truncated ? "（仅展示最近100条）" : ""}</summary><p>同任务其他轮次：${trace.related_trace_keys.map(link).join(" · ") || "无可关联样本"}</p><table><thead><tr><th>时间</th><th>事件</th><th>结果 / 错误码</th><th>毫秒</th><th>证据与上下文</th></tr></thead><tbody>${trace.events.map(event => `<tr><td>${escape(event.at)}</td><td>${escape(event.name)}</td><td>${escape(event.outcome)} / ${escape(event.reason)}${event.related_tool_reason ? `<br>对应主调用：${escape(event.related_tool_reason)}` : ""}</td><td>${Math.round(event.duration_ms)}</td><td>${escape(event.evidence)}<br>${escape(contextDescription(event.context))}<br>调用：${escape(event.call_id ?? "未知")}<br>操作：${escape(event.operation_id ?? "未知")}</td></tr>`).join("")}</tbody></table></details>`).join("");

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><title>Project Dev Agent 开发者诊断</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:15px/1.8 system-ui;color:#20312b;background:#f7f8f4}h1{font-size:30px}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;border-bottom:1px solid #dde3dd;padding:10px;overflow-wrap:anywhere}a{color:#17664e}details{margin:12px 0}summary{cursor:pointer;overflow-wrap:anywhere}.stats{display:flex;flex-wrap:wrap;gap:14px}.card{background:white;border:1px solid #dde3dd;padding:16px;border-radius:9px}.notice{padding:18px;background:#fff4dd}code{overflow-wrap:anywhere}@media(max-width:600px){body{margin:20px auto}table{font-size:12px}td{padding:5px}}</style><h1>插件开发者诊断</h1><p>样本 ${report.sample_events} 条 · ${escape(report.observed_from)} 至 ${escape(report.observed_to)}</p><p class="notice">仅供插件维护者排查和复测。损坏事件 ${report.coverage.invalid} 条；事件读取截断：${report.coverage.truncated ? "是" : "否"}。链路共 ${report.total_traces} 条，展示 ${report.traces.length} 条${report.traces_truncated ? "（达到 200 条上限）" : ""}。原始异常事件 ${report.signal_coverage.raw_events} 条，排除明确关联的派生重复 ${report.signal_coverage.excluded_derived_events} 条后，统计 ${report.signal_coverage.primary_signals} 条主信号；主信号也不等于独立缺陷数。安装标识 ${report.install_ids} 个，可能包含维护自测。</p><div class="stats">${Object.entries(report.counts).map(([key, value]) => `<div class="card"><b>${value}</b><br>${escape(labels[key] ?? key)}</div>`).join("")}<div class="card">钩子 p50 / p95<br>${escape(report.hook_duration_ms.p50)} / ${escape(report.hook_duration_ms.p95)} ms</div></div>${participationHtml}${incidents}<h2>问题聚类</h2><p>共 ${report.total_issue_clusters} 类，展示 ${report.issues.length} 类${report.issue_clusters_truncated ? "（截断）" : ""}；同类信号不等于同一根因。</p><table><thead><tr><th>版本 / 事件 / 错误码</th><th>次数</th><th>安装数</th><th>样本链路</th></tr></thead><tbody>${issues || '<tr><td colspan="4">本次样本没有观测到异常事件。</td></tr>'}</tbody></table><h2>链路明细</h2>${traces || '<p>尚无链路。</p>'}<h2>覆盖边界</h2><ul>${report.limitations.map(item => `<li>${escape(item)}</li>`).join("")}</ul></html>`;
}
