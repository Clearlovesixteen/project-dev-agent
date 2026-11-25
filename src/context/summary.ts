/** 默认上下文只给可追溯入口，完整条件、例外和源码仍按需读取。 */
export function compactContext(data: Record<string, any>) {
  const implementation = data.implementation_context ?? {};
  return {
    state: data.state, scan_id: data.scan_id ?? null,
    implementation: {
      project_instructions: (implementation.project_instructions ?? []).slice(0, 3),
      shared_entries: (implementation.shared_entries ?? []).slice(0, 3),
      request_entries: (implementation.request_entries ?? []).slice(0, 2),
      examples: (implementation.examples ?? []).slice(0, 2),
      candidates: (implementation.implementation_candidates?.candidates ?? []).slice(0, 3),
    },
    files: (data.files ?? []).slice(0, 4).map((item: any) => ({ path: item.path, sha256: item.sha256, relation: item.relation, source_state: item.source_state })),
    models: (data.models ?? []).slice(0, 3).map((model: any) => ({ id: model.id, revision: model.revision,
      title: model.title, summary: String(model.summary ?? "").slice(0, 140), status: model.status,
      rules: (model.rules ?? []).slice(0, 2).map((rule: any) => ({ id: rule.id, basis: rule.basis, description: String(rule.description ?? "").slice(0, 100), freshness: rule.freshness })),
      details_request: model.details_request ?? { model_id: model.id, model_revision: model.revision } })),
    review_candidates: (data.review_candidates ?? []).slice(0, 3).map((model: any) => ({ id: model.id, revision: model.revision,
      title: model.title, status: "needs_review", review_only: true, effective: false,
      details_request: model.details_request ?? { model_id: model.id, model_revision: model.revision } })),
    // 只把共享知识视图的状态和可追溯 ID 放入自动上下文；完整快照仍通过 project_context 按需读取。
    project_knowledge: data.project_knowledge ? {
      state: data.project_knowledge.state, project_id: data.project_knowledge.project_id,
      transaction_id: data.project_knowledge.transaction_id, view_token: data.project_knowledge.view_token,
      unresolved: (data.project_knowledge.unresolved ?? []).slice(0, 8),
    } : undefined,
    business_links: (data.business_graph?.edges ?? []).slice(0, 4),
    truncated: false,
  };
}

/** JSON 始终保持完整；按条目裁剪，不能截出半条业务规则或半个 UTF-8 字符。 */
export function boundedSummary(data: Record<string, any>, maximum = 4_000): string {
  const summary = compactContext(data);
  const source = data.implementation_context ?? {};
  const groups = [
    [summary.implementation.examples, source.examples], [summary.files, data.files],
    [summary.implementation.shared_entries, source.shared_entries], [summary.implementation.request_entries, source.request_entries],
    [summary.implementation.candidates, source.implementation_candidates?.candidates], [summary.business_links, data.business_graph?.edges],
    [summary.models, data.models], [summary.review_candidates, data.review_candidates], [summary.implementation.project_instructions, source.project_instructions],
  ];
  summary.truncated = !!(data.files_truncated || data.next_model_offset != null || data.business_graph?.truncated || source.truncated
    || source.implementation_candidates?.truncated || groups.some(([items, original]) => items.length < (original?.length ?? 0))
    || (data.models ?? []).some((model: any) => (model.rule_count ?? model.rules?.length ?? 0) > 2)
    || data.review_candidates_truncated
    || (data.project_knowledge?.unresolved?.length ?? 0) > 8);
  // 先保留每类首个来源，再按剩余预算裁剪。按整条裁剪，不能截断符号或半条业务依据。
  for (const reserve of [1, 0]) for (const [items] of groups) {
    while (items.length > reserve && Buffer.byteLength(JSON.stringify(summary)) > maximum) {
      items.pop();
      summary.truncated = true;
    }
  }
  return JSON.stringify(summary);
}
