import type { Knowledge } from "../domain/knowledge.js";
import type { ToolResult } from "../domain/result.js";
import type { searchSupportContext } from "../knowledge/support-context.js";

type KnowledgeEntry = Pick<Knowledge, "id" | "title" | "rule" | "applicable_conditions" | "paths" | "modules"> &
  { effective: boolean; file: string; version: string };
type SupportContext = Awaited<ReturnType<typeof searchSupportContext>>;

/** 按完整条目分配摘要空间；保留同一条规则的所有条件，过大时明确要求展开。 */
export function previewEntries<T>(entries: T[], bytes: number) {
  const items: T[] = [];
  let remaining = bytes;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (size > remaining || items.length >= 3) continue;
    items.push(entry);
    remaining -= size;
  }
  return { items, truncated: entries.length > items.length };
}

/** 只返回可直接核对的条件和版本。历史证据原话、完整反馈记录通过定向查询获取。 */
export function compactKnowledge(result: ToolResult | undefined, support?: SupportContext, excludedPaths = 0) {
  const state = !result ? "query_required" : result.code === "PATHS_EXCLUDED" ? "excluded"
    : result.outcome === "error" ? "unavailable" : result.outcome === "incomplete" ? "partial" : "available";
  const source = result?.data as { results?: KnowledgeEntry[]; notices?: { id: string; status: string }[]; notices_truncated?: boolean; truncated?: boolean } | undefined;
  const rules = previewEntries((source?.results ?? []).map(({ id, title, rule, applicable_conditions, paths, modules, effective, file, version }) =>
    ({ id, title, rule, applicable_conditions, paths, modules, effective, file, version })), 1_400);
  const notices = previewEntries((source?.notices ?? []).map(({ id, status }) => ({ id, status })), 250);
  const history = support?.history;
  const hints = previewEntries((history?.hints ?? []).map(({ id, audience, rule, applicable_conditions, paths, potential_conflicts, effective }) =>
    ({ id, audience, rule, applicable_conditions, paths, potential_conflicts, effective })), 1_100);
  const feedback = support?.feedback;
  const corrections = previewEntries((feedback?.items ?? []).map(({ input, effective }) => ({
    id: input.id, audience: input.audience, rule: input.rule, conditions: input.conditions, paths: input.paths, effective,
  })), 1_100);
  // 仅在详情能补足丢失或冲突的信息时建议再查；未扫描/待分析的历史保留真实覆盖状态。
  const rulesLookup = state === "unavailable" || state === "partial" || !!source?.truncated ||
    !!source?.notices_truncated || rules.truncated || notices.truncated;
  const historyLookup = !!history && (history.truncated || hints.truncated || history.hints.some(hint => hint.potential_conflicts.length));
  const feedbackLookup = !!feedback && (feedback.truncated || corrections.truncated);
  const lookup = rulesLookup || historyLookup || feedbackLookup;
  return { state, results: rules.items, notices: notices.items, rules_lookup_required: rulesLookup,
    history: { state: history?.state ?? state, hints: hints.items, lookup_required: historyLookup },
    feedback: { state: feedback?.state ?? state, version: excludedPaths ? null : feedback?.version ?? null, items: corrections.items,
      ...(excludedPaths ? { excluded_path_count: excludedPaths, scope_action: "当前范围含项目排除路径，所列纠正仅针对允许路径；请核对任务范围后再取版本。" } : {}),
      review_required: feedback?.state === "available" ? !!feedback.items.length : null, lookup_required: feedbackLookup },
    ...(lookup ? { details_request: { tool: "knowledge_search", scope: "传入本次 query、modules 和任务 scope_paths；按需查看标记的来源。" } } : {}) };
}
