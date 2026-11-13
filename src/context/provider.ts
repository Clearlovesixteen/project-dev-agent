import { ProjectFiles } from "../storage/project-files.js";
import { projectContext } from "../understanding/context.js";
import { ContextInput } from "../understanding/contracts.js";
import { searchKnowledge } from "../knowledge/search.js";
import { digest } from "../knowledge/document.js";
import { bindWorktree } from "../git/baseline.js";
import { readProjectKnowledge } from "../project-knowledge/service.js";

/** MCP 与原生钩子共用同一个查询和来源核验，不维护第二套业务判断。 */
export async function provideContext(files: ProjectFiles, input: unknown) {
  const request = ContextInput.parse(input);
  const context = await projectContext(files, request);
  const knowledge = request.query || request.paths.length || request.modules.length ? await searchKnowledge(files, {
    query: request.query, paths: request.paths, modules: request.modules, limit: 3,
  }) : undefined;
  // 原生钩子和 MCP 必须读取同一份项目知识视图；这里做只读绑定，失败只降级为不可用，
  // 不阻断既有的本地结构/模型查询，也不会因为普通对话创建共享知识库。
  let project_knowledge: Awaited<ReturnType<typeof readProjectKnowledge>>;
  try { project_knowledge = await readProjectKnowledge(await bindWorktree(files.root)); }
  catch (error) { project_knowledge = { state: "unavailable", snapshot_count: 0, message: error instanceof Error ? error.message : String(error) }; }
  const data = { ...context, ...(knowledge ? { knowledge_context: knowledge.data } : {}), project_knowledge };
  return { ...data, provider_version: 1, context_id: digest(JSON.stringify(data)) };
}
