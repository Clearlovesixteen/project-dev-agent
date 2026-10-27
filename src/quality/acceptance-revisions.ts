import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import { AcceptanceRevisionInput } from "./requirement-contracts.js";
import { z } from "zod";
import { sourceCheck } from "./requirement-review.js";

/** 含义变化必须先重开并关联纠正；来源替换与初次分类也留前后镜像，不覆盖旧结论。 */
export function acceptanceRevisions(
  task: Task,
  incoming: Task["acceptance_criteria"] | undefined,
  corrections: Task["corrections"],
  revision: z.infer<typeof AcceptanceRevisionInput> | undefined
) {
  const history = [...(task.acceptance_revisions ?? [])];
  if (!task.development_policy || !incoming) return history;
  const shape = (item: Task["acceptance_criteria"][number]) => ({
    id: item.id,
    description: item.description,
    check: sourceCheck(item),
  });
  const changed = incoming.filter((item) => {
    const before = task.acceptance_criteria.find((a) => a.id === item.id);
    return (
      before && JSON.stringify(shape(before)) !== JSON.stringify(shape(item))
    );
  });
  if (!changed.length) return history;
  if (changed.some((item) => item.status !== "pending"))
    throw new AppError(
      "ACCEPTANCE_REVISION_REQUIRED",
      "验收定义变化须先保存pending，不能直接套用原通过结论"
    );
  const semantic = changed.some((item) => {
    const before = task.acceptance_criteria.find((a) => a.id === item.id)!;
    return (
      before.description !== item.description ||
      (before.requirement_check &&
        sourceCheck(before).kind !== sourceCheck(item).kind)
    );
  });
  if (
    semantic &&
    (!revision || !corrections.some((c) => c.id === revision.correction_id))
  )
    throw new AppError(
      "ACCEPTANCE_REVISION_REQUIRED",
      "改变验收含义或类别须关联已保存的用户要求修订，并保留原因"
    );
  if (history.length >= 50)
    throw new AppError(
      "ACCEPTANCE_REVISION_LIMIT",
      "验收定义修订达到50次，请缩小任务范围"
    );
  history.push({
    before: changed.map((item) =>
      shape(task.acceptance_criteria.find((a) => a.id === item.id)!)
    ),
    after: changed.map(shape),
    reason:
      revision?.reason ?? "补齐本次验收分类或替换参考来源，保存后重新核验",
    ...(revision ? { correction_id: revision.correction_id } : {}),
    recorded_at: new Date().toISOString(),
  });
  return history;
}
