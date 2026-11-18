import { ProjectFiles } from "../storage/project-files.js";
import { projectContext } from "../understanding/context.js";
import { ContextInput } from "../understanding/contracts.js";
import { searchKnowledge } from "../knowledge/search.js";
import { digest } from "../knowledge/document.js";
import { bindWorktree } from "../git/baseline.js";
import { readProjectKnowledge } from "../project-knowledge/service.js";
import { loadConfig } from "../knowledge/config.js";
import { modelVisible, worktreeModel } from "../project-knowledge/worktree-models.js";

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
  const knowledge = request.query || request.paths.length || request.modules.length ? await searchKnowledge(files, {
    query: request.query, paths: request.paths, modules: request.modules, limit: 3,
  }) : undefined;
  const context_query_kind = request.model_id ? "model_details" : request.code_locations ? "code_locations" : "implementation";
  const data = { ...context, context_query_kind, ...(knowledge ? { knowledge_context: knowledge.data } : {}), ...(project_knowledge ? { project_knowledge } : {}) };
  return { ...data, provider_version: 1, context_id: digest(JSON.stringify(data)) };
}
