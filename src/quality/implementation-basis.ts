import type { WorkspaceBaseline } from "../domain/workspace-baseline.js";
import { baselineContent } from "../git/workspace-baseline.js";
import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/index.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { readGit } from "../git/command.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { ProjectFiles } from "../storage/project-files.js";
import {
  excluded,
  safeSource,
  sourceBoundary,
  MAX_SOURCE,
} from "../understanding/scan.js";
import type { ImplementationBasisInput } from "./basis-contracts.js";

type BasisReference = ImplementationBasisInput["references"][number];

type ReferenceBaseline = { binding: WorktreeBinding; head: string; workspace: WorkspaceBaseline | undefined };
type ReferenceConfig = Awaited<ReturnType<typeof loadConfig>>["config"];

function containsQuote(text: string, reference: BasisReference) {
  return (text.split(/\r?\n/)[reference.line - 1] ?? "").includes(reference.quote);
}

function matchesReference(text: string, reference: BasisReference) {
  return digest(text) === reference.sha256 && containsQuote(text, reference);
}

/** 基线回退也遵守当前配置、嵌套仓库与符号链接边界。 */
async function baselineMatches(files: ProjectFiles, config: ReferenceConfig, reference: BasisReference, baseline: ReferenceBaseline) {
  try {
    await files.path(reference.path, true);
    await sourceBoundary(files, reference.path, config);
    return matchesReference(await baselineContent(baseline.binding, baseline.head, reference.path, baseline.workspace), reference);
  } catch { return false; }
}

/** 已保存的引用可继续核对任务基线，新引用必须以当前工作树原文为准。 */
async function referenceState(files: ProjectFiles, config: ReferenceConfig, reference: BasisReference, baseline?: ReferenceBaseline) {
  if (excluded(reference.path, config)) return "stale";
  try {
    if (matchesReference(await safeSource(files, reference.path, config), reference)) return "current";
  } catch { /* 文件变化时，已保存的引用仍可尝试核对任务基线。 */ }
  return baseline && await baselineMatches(files, config, reference, baseline) ? "task_baseline" : "stale";
}

/** 这里只核验引用原文，不把文件名、相似度或引用格式有效当作理解了项目。 */
export async function recordImplementationBasis(
  binding: WorktreeBinding,
  head: string,
  basis: ImplementationBasisInput,
  acceptanceIds: string[],
  initial?: WorkspaceBaseline,
  previous?: ImplementationBasisInput,
) {
  if (
    basis.decisions.some((item) => !acceptanceIds.includes(item.acceptance_id))
  ) {
    throw new AppError(
      "IMPLEMENTATION_ACCEPTANCE_UNKNOWN",
      "实现决策必须关联本任务实际存在的验收项",
    );
  }
  const options = initial?.merge_recovery ? { allow_unmerged: true } : {};
  const before = await reviewSnapshot(binding, head, initial, options),
    files = new ProjectFiles(binding.root),
    { config } = await loadConfig(files);
  for (const reference of basis.references) {
    const prior = previous?.references.find(item => item.id === reference.id);
    const baseline = prior && JSON.stringify(prior) === JSON.stringify(reference) ? { binding, head, workspace: initial } : undefined;
    if (await referenceState(files, config, reference, baseline) === "stale") {
      throw new AppError(
        "IMPLEMENTATION_REFERENCE_INVALID",
        `请实际读取并核对实现依据的路径、哈希及行文：${reference.path}`,
      );
    }
  }
  // 避免引用读取期间代码变化，使记录的时机和快照与引用不属于同一工作树状态。
  if ((await reviewSnapshot(binding, head, initial, options)).hash !== before.hash)
    throw new AppError(
      "REVIEW_SNAPSHOT_CHANGED",
      "记录实现依据期间代码变化，请重新核对",
    );
  return {
    basis,
    recorded_at: new Date().toISOString(),
    review_snapshot: before.hash,
    timing: before.paths.length
      ? ("after_changes" as const)
      : ("before_changes" as const),
  };
}

/**
 * 写前仅验证引用，复用同一任务已核实的行文。每次重新读取真实配置和文件字节，
 * 用内容摘要比较来源；不会因 mtime 相同误用旧回执。基线回退每次独立核验。
 */
export async function checkWriteReferences(binding: WorktreeBinding, task: Task, prior?: string | null) {
  const record = task.implementation_bases?.at(-1);
  if (!record) return { valid: false, receipt: null };
  const files = new ProjectFiles(binding.root);
  const { config } = await loadConfig(files);
  const references = record.basis.references;
  const paths = [...new Set(references.map(reference => reference.path))];
  const sources = new Map(await Promise.all(paths.map(async path => {
    try {
      const text = await safeSource(files, path, config);
      return [path, { text, sha256: digest(text) }] as const;
    } catch { return [path, undefined] as const; }
  })));
  // 只有所有来源仍精确匹配当前源码时才颁发可重用回执。
  if (references.every(ref => sources.get(ref.path)?.sha256 === ref.sha256)) {
    const receipt = digest(JSON.stringify([binding.root, binding.repo_identity, binding.branch, binding.head,
      task.id, task.revision, record.basis, config]));
    if (receipt === prior) return { valid: true, receipt };
    const valid = references.every(ref => containsQuote(sources.get(ref.path)!.text, ref));
    return { valid, receipt: valid ? receipt : null };
  }
  // 合法的本任务内修改可改变引用文件，保留现有的不可变基线核验语义。
  for (const reference of references) {
    const current = sources.get(reference.path);
    if (current?.sha256 === reference.sha256 && containsQuote(current.text, reference)) continue;
    if (!await baselineMatches(files, config, reference, { binding, head: task.baseline_head, workspace: task.workspace_baseline }))
      return { valid: false, receipt: null };
  }
  return { valid: true, receipt: null };
}

/** 约束、实施选择或引用发生变化时只重开对应验收，移除决策也要复核其原验收。 */
export function implementationAcceptanceToReopen(previous: ImplementationBasisInput | undefined, next: ImplementationBasisInput) {
  const before = new Map(previous?.decisions.map(decision => [decision.id, decision]));
  const after = new Map(next.decisions.map(decision => [decision.id, decision]));
  const oldRefs = new Map(previous?.references.map(reference => [reference.id, reference]));
  const newRefs = new Map(next.references.map(reference => [reference.id, reference]));
  const reopen = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const original = before.get(id), updated = after.get(id);
    if (original && updated && previous?.absence_reason === next.absence_reason && JSON.stringify(original) === JSON.stringify(updated)
      && updated.reference_ids.every(ref => JSON.stringify(oldRefs.get(ref)) === JSON.stringify(newRefs.get(ref)))) continue;
    if (original) reopen.add(original.acceptance_id);
    if (updated) reopen.add(updated.acceptance_id);
  }
  return reopen;
}

/** 所有实现决策共用这条复核路径；不针对某一种库、语言或设计模式设专用表单。 */
export async function implementationBasisReview(
  binding: WorktreeBinding,
  task: Task,
  snapshot: string,
) {
  const history = task.implementation_bases ?? [],
    record = history.at(-1),
    required = task.implementation_policy === 1 || !!record;
  const limitation =
    "核验的是原文依据、实现决策与当前验收记录；不证明语义理解或设计合理。记录时已有改动会如实标注，不伪装为编码前准备。";
  if (!record)
    return {
      state: required ? ("missing" as const) : ("legacy" as const),
      required,
      basis_count: 0,
      references: [],
      decisions: [],
      limitation,
    };
  const files = new ProjectFiles(binding.root),
    { config } = await loadConfig(files),
    references = [];
  for (const reference of record.basis.references) {
    const state = await referenceState(files, config, reference, {
      binding, head: task.baseline_head, workspace: task.workspace_baseline,
    });
    references.push({ id: reference.id, path: reference.path, state });
  }
  const decisions = record.basis.decisions.map((decision) => {
    const criterion = task.acceptance_criteria.find(
      (item) => item.id === decision.acceptance_id,
    );
    const state =
      !criterion || criterion.status !== "checked"
        ? "pending"
        : criterion.review_snapshot !== snapshot
        ? "stale"
        : "checked";
    return {
      id: decision.id,
      acceptance_id: decision.acceptance_id,
      reference_ids: decision.reference_ids,
      state,
    };
  });
  const stale =
    references.some((item) => item.state === "stale") ||
    decisions.some((item) => item.state === "stale");
  return {
    state: stale
      ? ("stale" as const)
      : decisions.some((item) => item.state !== "checked")
      ? ("pending" as const)
      : ("checked" as const),
    required,
    basis_count: history.length,
    timing: record.timing,
    first_timing: history[0]!.timing,
    references,
    decisions,
    ...(record.basis.absence_reason
      ? { absence_reason: record.basis.absence_reason }
      : {}),
    limitation,
  };
}

export function assertImplementationBasis(
  review: Awaited<ReturnType<typeof implementationBasisReview>>,
): void {
  if (!review.required || review.state === "checked") return;
  throw new AppError(
    review.state === "missing"
      ? "IMPLEMENTATION_BASIS_REQUIRED"
      : "IMPLEMENTATION_BASIS_REVIEW_REQUIRED",
    "先调用 task_check 查看 next_actions，在当前代码快照上完成列出的核对，再关闭任务",
  );
}

/**
 * 给调用者一次返回所有实现依据待办。更新引用与复核验收是不同动作，已有有效依据可以直接沿用。
 * 这里不生成证据，也不调整关闭任务所需的真实验收。
 */
export function implementationReviewActions(review: Awaited<ReturnType<typeof implementationBasisReview>>) {
  if (review.state === "missing") return [{
    action: "record_implementation_basis", tool: "task_update", fields: ["implementation_basis"],
    instruction: "读取项目约束和同类实现，记录本次实施选择并关联实际验收项。",
  }];
  const references = review.references.filter(item => item.state === "stale").map(({ id, path }) => ({ id, path }));
  const staleReferences = new Set(references.map(item => item.id));
  const affected = review.decisions.filter(item => item.reference_ids.some(id => staleReferences.has(id)));
  const pending = review.decisions.filter(item => item.state === "pending");
  const stale = review.decisions.filter(item => item.state === "stale");
  return [
    ...(references.length ? [{
      action: "refresh_implementation_references", tool: "task_update", fields: ["implementation_basis", "acceptance_criteria"],
      references, reopen_acceptance_ids: [...new Set(affected.map(item => item.acceptance_id))],
      instruction: "重新核对列出的引用并追加依据修订，将受影响的验收项重开为 pending，再通过 task_check 获取当前复核项。",
    }] : []),
    ...(pending.length || stale.length ? [{
      action: "review_linked_acceptance", tool: "task_update",
      fields: ["acceptance_criteria", "review_snapshot", ...(stale.length ? ["reviewed_ids.acceptance_criteria"] : [])],
      decision_ids: [...pending, ...stale].map(item => item.id),
      pending_acceptance_ids: [...new Set(pending.map(item => item.acceptance_id))],
      stale_acceptance_ids: [...new Set(stale.map(item => item.acceptance_id))],
      instruction: "在当前快照实际验证列出的验收项，再提交对应证据。已有完成项只在实际重核后列入 reviewed_ids。",
    }] : []),
  ];
}
