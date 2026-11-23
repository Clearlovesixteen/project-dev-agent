import type { ToolResult } from "../domain/result.js";
import type { Task } from "../domain/task.js";

/** 保存成功后给 Codex 小回执。原始任务、诊断、权限判断与验收数据仍由领域服务维护。 */
export function compactTaskReceipt(result: ToolResult): ToolResult {
  if (result.outcome !== "ok" || !result.data || typeof result.data !== "object") return result;
  const task = result.data as Partial<Task>;
  if (typeof task.id !== "string" || typeof task.revision !== "number" || !task.phase) return result;
  return { ...result, data: {
    view: "compact", id: task.id, revision: task.revision, phase: task.phase,
    requirement_group_id: task.requirement_group_id,
    parallel_state: task.parallel_state,
    change_count: task.change_items?.length ?? 0,
    acceptance_count: task.acceptance_criteria?.length ?? 0,
    validation_plan_version: task.validation_plans?.at(-1)?.version,
    // 恢复与读取详情使用已有工具；成功回执本身不触发额外查询。
    details_request: { task_id: task.id, mode: "review" },
  } };
}
