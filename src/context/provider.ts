import { ProjectFiles } from "../storage/project-files.js";
import { projectContext } from "../understanding/context.js";
import { ContextInput } from "../understanding/contracts.js";
import { scopedKnowledgeSearch } from "../knowledge/search.js";
import { digest } from "../knowledge/document.js";
import { bindWorktree } from "../git/baseline.js";
import { readProjectKnowledge } from "../project-knowledge/service.js";
import { loadConfig } from "../knowledge/config.js";
import { modelVisible, worktreeModel } from "../project-knowledge/worktree-models.js";
import { boundedSummary } from "./summary.js";
import { compactKnowledge, previewEntries } from "./compact-knowledge.js";
import { searchSupportContext } from "../knowledge/support-context.js";
import type { ToolResult } from "../domain/result.js";

/** 查询类型由服务根据请求判定，便于修改前检查区分开发依据与只读详情。 */
export async function provideContext(files: ProjectFiles, input: unknown) {
  const request = ContextInput.parse(input);
  // 本地结构和共享知识独立降级，查询不创建共享知识库。
  let project_knowledge: Awaited<ReturnType<typeof readProjectKnowledge>> | undefined;
  try { project_knowledge = await readProjectKnowledge(await bindWorktree(files.root)); }
  catch (error) { project_knowledge = { state: "unavailable", snapshot_count: 0, message: error instanceof Error ? error.message : String(error) }; }
  if (project_knowledge?.selected_models?.length) {
    const { config } = await loadConfig(files);
    project_knowledge = { ...project_knowledge, selected_models: project_knowledge.selected_models.filter(snapshot => {
      const model = worktreeModel(files.root, snapshot.content, snapshot.model_id);
      return model && modelVisible(model, config);
    }) };
  }
  const context = await projectContext(files, request, project_knowledge);
  const context_query_kind = request.model_id ? "model_details" : request.code_locations ? "code_locations" : "implementation";
  const compactView = request.view === "compact" && context_query_kind === "implementation";
  let knowledge: ToolResult | undefined;
  let allowedPaths: string[] = [];
  if (request.query || request.paths.length || request.modules.length) {
    try {
      const scoped = await scopedKnowledgeSearch(files, { query: request.query, paths: request.paths, modules: request.modules, limit: 3 });
      knowledge = scoped.result;
      allowedPaths = scoped.paths;
    } catch (error) {
      if (!compactView) throw error;
      knowledge = { outcome: "error", code: "KNOWLEDGE_UNAVAILABLE", diagnostics: [{ code: "KNOWLEDGE_UNAVAILABLE", message: "本次知识查询未能完成" }] };
    }
  }
  const data = { ...context, context_query_kind, ...(knowledge ? { knowledge_context: knowledge.data } : {}), ...(project_knowledge ? { project_knowledge } : {}) };
  // 规则、纠正与历史共用详情查询的匹配逻辑，仅 compact 分摊载荷和读取预算。
  if (compactView) {
    const support = knowledge && knowledge.code !== "PATHS_EXCLUDED" && knowledge.outcome !== "error"
      ? await searchSupportContext(files, request.query, allowedPaths, 3, true) : undefined;
    const knowledge_context = compactKnowledge(knowledge, support, support ? request.paths.length - allowedPaths.length : 0);
    const unindexed = previewEntries(context.unindexed_paths ?? [], 1_200);
    const compact = JSON.parse(boundedSummary(data, 11_350 - Buffer.byteLength(JSON.stringify(knowledge_context)) - Buffer.byteLength(JSON.stringify(unindexed.items))));
    const { candidates, ...implementation } = compact.implementation;
    const summary = { state: data.state, scan_id: compact.scan_id, context_query_kind,
      ...(context.implementation_context ? { implementation_context: { ...implementation, implementation_candidates: { candidates, truncated: true } } } : {}),
      files: compact.files, models: compact.models, knowledge_context, business_links: compact.business_links,
      unindexed_paths: unindexed.items, unindexed_paths_truncated: unindexed.truncated, project_knowledge: compact.project_knowledge,
      truncated: true, next_step: context.next_step ?? "核对候选的源码。使用 model_id 展开条件、例外与证据；需要更多结果时缩小 paths 或使用 view:full。"};
    return { ...summary, provider_version: 1, context_id: digest(JSON.stringify(summary)) };
  }
  return { ...data, provider_version: 1, context_id: digest(JSON.stringify(data)) };
}
