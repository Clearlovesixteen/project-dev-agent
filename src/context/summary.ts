/** 默认上下文只给可追溯入口，完整条件、例外和源码仍按需读取。 */
export function compactContext(data: Record<string, any>) {
  const implementation = data.implementation_context ?? {};
  return {
    state: data.state, scan_id: data.scan_id ?? null,
    implementation: {
      project_instructions: (implementation.project_instructions ?? []).slice(0, 3),
      shared_entries: (implementation.shared_entries ?? []).slice(0, 3),
      examples: (implementation.examples ?? []).slice(0, 2),
      candidates: (implementation.implementation_candidates?.candidates ?? []).slice(0, 3),
    },
    files: (data.files ?? []).slice(0, 4).map((item: any) => ({ path: item.path, sha256: item.sha256, relation: item.relation, source_state: item.source_state })),
    models: (data.models ?? []).slice(0, 3).map((model: any) => ({ id: model.id, revision: model.revision,
      title: model.title, summary: String(model.summary ?? "").slice(0, 140), status: model.status,
      rules: (model.rules ?? []).slice(0, 2).map((rule: any) => ({ id: rule.id, basis: rule.basis, description: String(rule.description ?? "").slice(0, 100), freshness: rule.freshness })),
      details_request: model.details_request ?? { model_id: model.id, model_revision: model.revision } })),
    knowledge: (data.knowledge_context?.results ?? []).slice(0, 3).map((entry: any) => ({ id: entry.id, title: entry.title,
      rule: String(entry.rule ?? "").slice(0, 180), effective: entry.effective, file: entry.file, version: entry.version })),
    business_links: (data.business_graph?.edges ?? []).slice(0, 4),
    truncated: true,
  };
}

/** JSON 始终保持完整；按条目裁剪，不能截出半条业务规则或半个 UTF-8 字符。 */
export function boundedSummary(data: Record<string, any>, maximum = 4_000): string {
  const summary = compactContext(data);
  for (const list of [summary.business_links, summary.implementation.candidates, summary.implementation.shared_entries,
    summary.files, summary.knowledge, summary.implementation.examples, summary.models, summary.implementation.project_instructions]) {
    while (Buffer.byteLength(JSON.stringify(summary)) > maximum && list.length) list.pop();
  }
  return JSON.stringify(summary);
}
