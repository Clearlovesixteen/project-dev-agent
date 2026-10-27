import type { Task } from "../domain/task.js";
import type { TaskUpdateInput } from "../tools/inputs.js";
import type { WorktreeBinding } from "../git/index.js";
import { AppError } from "../domain/error.js";
import {
  recordRequirementSources,
  latestSources,
  sourceCheck,
} from "./requirement-review.js";
import { acceptanceRevisions } from "./acceptance-revisions.js";
/** 来源与验收定义分别追加历史；重开后再核验，不在关闭时补造准备。 */
export async function prepareRequirementUpdate(
  binding: WorktreeBinding,
  current: Task,
  request: TaskUpdateInput,
) {
  let requirementSources = current.requirement_sources;
  if (request.requirement_sources) {
    if (
      request.requirement_sources.some((source) => source.id === "task-request")
    )
      throw new AppError(
        "REQUIREMENT_SOURCE_RESERVED",
        "原始要求来源不可覆盖，修订要求使用新的纠正来源",
      );
    if (request.phase === "closed")
      throw new AppError(
        "REQUIREMENT_REVIEW_REQUIRED",
        "先保存来源修订，再核验受影响的验收",
      );
    requirementSources = await recordRequirementSources(
      binding,
      {
        ...current,
        corrections: request.corrections ?? current.corrections,
      },
      requirementSources ?? [],
      request.requirement_sources,
    );
    const old = latestSources(current.requirement_sources ?? []),
      latest = latestSources(requirementSources),
      changed = latest
        .filter(
          (source) =>
            old.find((item) => item.input.id === source.input.id)
              ?.fingerprint !== source.fingerprint,
        )
        .map((source) => source.input.id);
    if (
      (request.acceptance_criteria ?? current.acceptance_criteria).some(
        (item) =>
          item.status === "checked" &&
          sourceCheck(item).source_ids.some((id) => changed.includes(id)),
      )
    )
      throw new AppError(
        "REQUIREMENT_REVIEW_REQUIRED",
        "来源变化先将相关验收重开为pending，保存后重新核验",
      );
  }
  if (
    request.business_assessment &&
    JSON.stringify(request.business_assessment) !==
      JSON.stringify(current.business_assessment) &&
    (request.acceptance_criteria ?? current.acceptance_criteria).some(
      (item) => item.status === "checked",
    )
  )
    throw new AppError(
      "BUSINESS_ASSESSMENT_REVIEW_REQUIRED",
      "业务影响判断变化后先重开验收，保存后重新核验",
    );
  if (request.business_assessment && request.phase === "closed")
    throw new AppError(
      "BUSINESS_ASSESSMENT_REQUIRED",
      "先保存业务影响评估，再核验和关闭",
    );
  const acceptance_revisions = acceptanceRevisions(
    current,
    request.acceptance_criteria,
    request.corrections ?? current.corrections,
    request.acceptance_revision,
  );
  return {
    ...(requirementSources ? { requirement_sources: requirementSources } : {}),
    ...(current.development_policy ? { acceptance_revisions } : {}),
    ...(request.business_assessment
      ? { business_assessment: request.business_assessment }
      : {}),
  };
}
