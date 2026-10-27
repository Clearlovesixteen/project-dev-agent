import { z } from "zod";
import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { safeSource } from "../understanding/scan.js";
import { loadConfig } from "../knowledge/config.js";
import { workspaceContent } from "../git/workspace-content.js";
import { models } from "../understanding/store.js";
import {
  RequirementSourceInput,
  RequirementSourceRecord,
} from "./requirement-contracts.js";
type Input = z.infer<typeof RequirementSourceInput>;
type Record = z.infer<typeof RequirementSourceRecord>;
export const sourceCheck = (item: Task["acceptance_criteria"][number]) =>
  item.requirement_check ?? { kind: "technical", source_ids: ["task-request"] };
export function latestSources(records: Record[]) {
  return [...new Map(records.map((item) => [item.input.id, item])).values()];
}

async function captureSource(
  binding: WorktreeBinding,
  task: Pick<Task, "requirement" | "corrections">,
  value: Input,
): Promise<Input> {
  const input = RequirementSourceInput.parse(value),
    files = new ProjectFiles(binding.root);
  if (input.kind === "unavailable") {
    if (!input.locator || !input.reason)
      throw new AppError(
        "REQUIREMENT_SOURCE_INVALID",
        "不可用来源须保留地址及原因",
      );
    return input;
  }
  if (input.kind === "request" || input.kind === "correction") {
    const original =
      input.kind === "request"
        ? task.requirement
        : task.corrections.find((item) => item.id === input.correction_id)
            ?.description;
    if (!original || !input.quote || !original.includes(input.quote))
      throw new AppError(
        "REQUIREMENT_SOURCE_INVALID",
        "需求依据须匹配本任务已保存的原话或纠正",
      );
    return RequirementSourceInput.parse({ ...input, sha256: digest(original) });
  }
  if (!input.path)
    throw new AppError(
      "REQUIREMENT_SOURCE_INVALID",
      "文档或图片须有本项目可核对的路径，外部附件先由原终端受控缓存",
    );
  const { config } = await loadConfig(files);
  let sha: string;
  if (input.kind === "document") {
    const text = input.path.startsWith(".project-dev/local/requirements/")
      ? await files.read(input.path, 65536)
      : await safeSource(files, input.path, config);
    if (!input.quote || !text.includes(input.quote))
      throw new AppError(
        "REQUIREMENT_SOURCE_INVALID",
        "文档依据须保留匹配的原文",
      );
    sha = digest(text);
  } else {
    if (!input.path.startsWith(".project-dev/local/requirements/"))
      throw new AppError(
        "REQUIREMENT_SOURCE_INVALID",
        "原型图片使用本项目独立资料目录，不读取任意外部路径",
      );
    const { entry, content } = await workspaceContent(files, input.path, true);
    if (entry.kind !== "file")
      throw new AppError(
        "REQUIREMENT_SOURCE_INVALID",
        "原型图片必须是可读取的普通文件",
      );
    if (
      !content ||
      !(
        content
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (content[0] === 255 && content[1] === 216) ||
        content.subarray(0, 6).toString().startsWith("GIF8") ||
        (content.subarray(0, 4).toString() === "RIFF" &&
          content.subarray(8, 12).toString() === "WEBP")
      )
    )
      throw new AppError(
        "REQUIREMENT_SOURCE_INVALID",
        "图片资料需是PNG、JPEG、GIF或WebP，不能用任意文本伪装原型",
      );
    sha = entry.sha256!;
  }
  if (input.sha256 && input.sha256 !== sha)
    throw new AppError("REQUIREMENT_SOURCE_STALE", "来源内容与指定版本不一致");
  return RequirementSourceInput.parse({ ...input, sha256: sha });
}
export async function recordRequirementSources(
  binding: WorktreeBinding,
  task: Pick<Task, "requirement" | "corrections">,
  previous: Record[],
  values: Input[],
) {
  const history = [...previous];
  for (const value of values) {
    const input = await captureSource(binding, task, value),
      fingerprint = digest(JSON.stringify(input));
    if (
      history.filter((item) => item.input.id === input.id).at(-1)
        ?.fingerprint !== fingerprint
    )
      history.push({
        input,
        fingerprint,
        recorded_at: new Date().toISOString(),
      });
  }
  if (history.length > 100)
    throw new AppError(
      "REQUIREMENT_SOURCE_LIMIT",
      "需求来源修订超过100条，请缩小任务范围",
    );
  return history;
}
async function available(binding: WorktreeBinding, task: Task, source: Record) {
  if (source.input.kind === "unavailable") return false;
  try {
    return (
      digest(
        JSON.stringify(await captureSource(binding, task, source.input)),
      ) === source.fingerprint
    );
  } catch {
    return false;
  }
}
/** 服务为本次实际复核的验收绑定当前来源版本，完整回传不会刷新其他项目的旧来源。 */
export async function stampRequirementSources(
  binding: WorktreeBinding,
  task: Task,
  reviewed: string[],
) {
  if (!task.development_policy) return task;
  const sources = latestSources(task.requirement_sources ?? []);
  const acceptance = [];
  for (const item of task.acceptance_criteria) {
    if (!reviewed.includes(item.id) || item.status !== "checked") {
      acceptance.push(item);
      continue;
    }
    const check = sourceCheck(item),
      selected = check.source_ids.map((id) =>
        sources.find((source) => source.input.id === id),
      );
    if (
      selected.some((source) => !source) ||
      !(
        await Promise.all(
          selected.map((source) => available(binding, task, source!)),
        )
      ).every(Boolean)
    )
      throw new AppError(
        "REQUIREMENT_SOURCE_UNAVAILABLE",
        "验收来源缺失、不可读或已变化，保持pending并补齐依据后重新核验",
      );
    if (
      check.kind === "visual" &&
      !selected.some((source) =>
        ["image", "document"].includes(source!.input.kind),
      )
    )
      throw new AppError(
        "VISUAL_SOURCE_REQUIRED",
        "视觉对齐须有可读取的原型图片或文档，测试通过不能替代原型核对",
      );
    acceptance.push({
      ...item,
      requirement_versions: selected.map((source) => ({
        id: source!.input.id,
        fingerprint: source!.fingerprint,
      })),
    });
  }
  return { ...task, acceptance_criteria: acceptance };
}
export async function requirementReview(binding: WorktreeBinding, task: Task) {
  if (!task.development_policy)
    return { state: "legacy", required: false, items: [] };
  const sources = latestSources(task.requirement_sources ?? []),
    items = [];
  for (const item of task.acceptance_criteria) {
    const check = sourceCheck(item),
      selected = check.source_ids.map((id) =>
        sources.find((source) => source.input.id === id),
      );
    const current =
      selected.every(Boolean) &&
      (
        await Promise.all(
          selected.map((source) => available(binding, task, source!)),
        )
      ).every(Boolean);
    const bound =
      item.requirement_versions?.length === selected.length &&
      selected.every((source) =>
        item.requirement_versions?.some(
          (v) =>
            v.id === source?.input.id && v.fingerprint === source.fingerprint,
        ),
      );
    const visual =
      check.kind !== "visual" ||
      selected.some(
        (source) => source && ["image", "document"].includes(source.input.kind),
      );
    items.push({
      id: item.id,
      kind: check.kind,
      source_ids: check.source_ids,
      state: !current
        ? "source_unavailable"
        : !visual
        ? "visual_source_missing"
        : item.status !== "checked"
        ? "pending"
        : !bound
        ? "source_stale"
        : "checked",
    });
  }
  return {
    state: items.every((item) => item.state === "checked")
      ? "checked"
      : "pending",
    required: true,
    items,
  };
}
export async function businessAssessmentReview(
  binding: WorktreeBinding,
  task: Task,
) {
  if (!task.development_policy) return { state: "legacy", required: false };
  const active = (task.business_deltas ?? []).filter(
      (d) =>
        !task.business_deltas?.some(
          (other) => other.input.supersedes_id === d.input.id,
        ),
    ),
    assessment = task.business_assessment;
  if (!assessment) return { state: "missing", required: true };
  if (assessment.state === "unknown")
    return { state: "unknown", required: true, reason: assessment.reason };
  if (assessment.state === "unchanged")
    return {
      state: active.length ? "conflict" : "checked",
      required: true,
      reason: assessment.reason,
    };
  if (
    !assessment.model_ids.length ||
    !assessment.delta_ids.length ||
    assessment.delta_ids.some((id) => !active.some((d) => d.input.id === id)) ||
    active.some(
      (d) =>
        !assessment.delta_ids.includes(d.input.id) ||
        !assessment.model_ids.includes(d.input.model_id),
    )
  )
    return { state: "incomplete", required: true };
  const all = await models(new ProjectFiles(binding.root));
  return {
    state: assessment.model_ids.every((id) =>
      all.some((model) => model.id === id && model.schema_version === 2),
    )
      ? "checked"
      : "model_required",
    required: true,
    reason: assessment.reason,
  };
}
export async function assertRequirementReview(
  binding: WorktreeBinding,
  task: Task,
) {
  const requirements = await requirementReview(binding, task);
  if (requirements.required && requirements.state !== "checked")
    throw new AppError(
      "REQUIREMENT_ACCEPTANCE_REQUIRED",
      "需求、接口及原型来源须逐项绑定并在当前版本核验，缺失来源不能宣称完成",
    );
  const business = await businessAssessmentReview(binding, task);
  if (business.required && business.state !== "checked")
    throw new AppError(
      "BUSINESS_ASSESSMENT_REQUIRED",
      "先明确业务规则影响；变化时绑定模型、业务草案与场景，不改变业务也保留具体判断原因",
    );
}
