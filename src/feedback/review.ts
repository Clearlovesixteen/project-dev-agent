import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { AppError } from "../domain/error.js";
import { feedbackContext } from "./service.js";
export async function feedbackReview(
  binding: WorktreeBinding,
  task: Task,
  snapshot: string,
) {
  if (!task.feedback_policy)
    return { state: "legacy", required: false, items: [] };
  const context = await feedbackContext(
      new ProjectFiles(binding.root),
      task.requirement,
      task.scope_paths ?? [],
    ),
    record = task.feedback_review;
  const missing = context.items.filter(
    (item) => !record?.decisions.some((d) => d.id === item.input.id),
  );
  const pending =
    record?.decisions.filter(
      (d) =>
        d.disposition === "apply" &&
        (!d.acceptance_ids.length ||
          d.acceptance_ids.some(
            (id) =>
              !task.acceptance_criteria.some(
                (a) =>
                  a.id === id &&
                  a.status === "checked" &&
                  a.review_snapshot === snapshot,
              ),
          )),
    ) ?? [];
  return {
    state: context.truncated
      ? "incomplete"
      : record?.version !== context.version
      ? "stale"
      : missing.length || pending.length
      ? "pending"
      : "checked",
    required: true,
    version: context.version,
    missing_ids: missing.map((item) => item.input.id),
    pending_ids: pending.map((item) => item.id),
    items: context.items,
  };
}
export async function assertFeedback(
  binding: WorktreeBinding,
  task: Task,
  snapshot: string,
) {
  const result = await feedbackReview(binding, task, snapshot);
  if (result.required && result.state !== "checked")
    throw new AppError(
      "FEEDBACK_REVIEW_REQUIRED",
      "读取当前相关纠正，说明本次适用选择并复核关联验收；不能沿用旧反馈版本关闭",
    );
}
