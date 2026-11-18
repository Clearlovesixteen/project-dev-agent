import { digest } from "../knowledge/document.js";
import type { WorktreeBinding } from "../git/index.js";
import { readProjectKnowledgeLight } from "../project-knowledge/service.js";
import { ProjectFiles } from "../storage/project-files.js";
import { readMap } from "../understanding/store.js";

/** 提示词钩子只读取索引清单和共享事务指针。源码指纹、索引分块和实现依据由 MCP 查询。 */
export async function promptProjectStatus(binding: WorktreeBinding) {
  const [map, project_knowledge] = await Promise.all([
    readMap(new ProjectFiles(binding.root)).catch(() => null),
    readProjectKnowledgeLight(binding),
  ]);
  const state = map === null ? "unavailable" : !map ? "not_scanned"
    : map.head !== binding.head ? "needs_rescan" : map.coverage.complete ? "indexed" : "partial";
  const summary = { state, scan_id: map?.scan_id ?? null, project_knowledge };
  return { ...summary, context_id: digest(JSON.stringify(summary)) };
}
