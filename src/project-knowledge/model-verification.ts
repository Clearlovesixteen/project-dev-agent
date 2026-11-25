import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/baseline.js";
import { readProjectKnowledge, publishModelVerification } from "./service.js";

/**
 * 关闭任务后只为本任务实际验收过的模型写入 verified 快照，失败保留候选并返回诊断。
 * 每个模型重新读取 CURRENT 并携带事务号，多个模型可以顺序提升，外部并发更新会被 CAS 拒绝。
 */
export async function verifyClosedTaskModels(binding: WorktreeBinding, task: Task, reviewSnapshot: string) {
  const modelIds = new Set([
    ...(task.business_plans?.at(-1)?.input.rules.map(rule => rule.model_id) ?? []),
    ...task.acceptance_criteria.filter(item => item.business_check).map(item => item.business_check!.model_id),
  ]);
  if (!modelIds.size) return [] as { code: string; message: string }[];
  const diagnostics: { code: string; message: string }[] = [];
  for (const modelId of modelIds) {
    const knowledge = await readProjectKnowledge(binding);
    const current = knowledge.selected_models?.find(item => item.model_id === modelId);
    if (!current) {
      diagnostics.push({ code: "PROJECT_MODEL_VERIFICATION_PENDING", message: `${modelId} 当前没有唯一匹配的模型快照` });
      continue;
    }
    const baseSnapshotId = task.business_plans?.at(-1)?.base_snapshot_ids?.find(item => item.model_id === modelId)?.snapshot_id;
    try {
      await publishModelVerification(binding, {
        operation_id: `model-verify:${task.id}:${task.revision}:${modelId}:${reviewSnapshot}`,
        task_id: task.id,
        model_id: modelId,
        snapshot_id: current.snapshot_id,
        review_snapshot: reviewSnapshot,
        ...(baseSnapshotId ? { base_snapshot_id: baseSnapshotId } : {}),
        expected_transaction_id: knowledge.transaction_id ?? null,
      });
    } catch (error) {
      diagnostics.push({ code: "PROJECT_MODEL_VERIFICATION_PENDING", message: `${modelId} 未能提升为 verified：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return diagnostics;
}
