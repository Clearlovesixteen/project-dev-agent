import { ProjectFiles } from "../storage/project-files.js";
import { projectContext } from "../understanding/context.js";
import { ContextInput } from "../understanding/contracts.js";
import { searchKnowledge } from "../knowledge/search.js";
import { digest } from "../knowledge/document.js";

/** MCP 与原生钩子共用同一个查询和来源核验，不维护第二套业务判断。 */
export async function provideContext(files: ProjectFiles, input: unknown) {
  const request = ContextInput.parse(input);
  const context = await projectContext(files, request);
  const knowledge = request.query || request.paths.length || request.modules.length ? await searchKnowledge(files, {
    query: request.query, paths: request.paths, modules: request.modules, limit: 3,
  }) : undefined;
  const data = { ...context, ...(knowledge ? { knowledge_context: knowledge.data } : {}) };
  return { ...data, provider_version: 1, context_id: digest(JSON.stringify(data)) };
}
