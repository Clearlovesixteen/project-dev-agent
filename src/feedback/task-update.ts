import type { Task } from "../domain/task.js";
import type { TaskUpdateInput } from "../tools/inputs.js";
import type { WorktreeBinding } from "../git/index.js";
import { AppError } from "../domain/error.js";
import { ProjectFiles } from "../storage/project-files.js";
import { feedbackContext } from "./service.js";
/** 纠正选择先绑定现有验收并保存；同一更新不能补记录后直接关闭。 */
export async function validateFeedbackUpdate(
  binding: WorktreeBinding,
  current: Task,
  request: TaskUpdateInput
) {
  if (request.feedback_review) {
    if (request.phase === "closed")
      throw new AppError(
        "FEEDBACK_REVIEW_REQUIRED",
        "先保存当前纠正选择，再核验关联验收"
      );
    const context = await feedbackContext(
      new ProjectFiles(binding.root),
      current.requirement,
      current.scope_paths ?? []
    );
    if (
      request.feedback_review.version !== context.version ||
      request.feedback_review.decisions.some(
        (d) =>
          !context.items.some((item) => item.input.id === d.id) ||
          d.acceptance_ids.some(
            (id) =>
              !(
                request.acceptance_criteria ?? current.acceptance_criteria
              ).some((a) => a.id === id)
          )
      )
    )
      throw new AppError(
        "FEEDBACK_REVIEW_INVALID",
        "纠正版本、ID或关联验收不匹配"
      );
    if (
      request.feedback_review.decisions.some(
        (d) =>
          d.disposition === "apply" &&
          d.acceptance_ids.some((id) =>
            (request.acceptance_criteria ?? current.acceptance_criteria).some(
              (a) => a.id === id && a.status !== "pending"
            )
          )
      )
    )
      throw new AppError(
        "FEEDBACK_REVIEW_REQUIRED",
        "修订纠正选择前先将关联验收重开为pending，保存后重新核验"
      );
  }
}
