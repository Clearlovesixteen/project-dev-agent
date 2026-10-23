import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/index.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { readGit } from "../git/command.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { ProjectFiles } from "../storage/project-files.js";
import { excluded, safeSource, sourceBoundary, MAX_SOURCE } from "../understanding/scan.js";
import type { ImplementationBasisInput } from "./basis-contracts.js";

function matchesReference(text: string, reference: ImplementationBasisInput["references"][number]): boolean {
  return digest(text) === reference.sha256 && (text.split(/\r?\n/)[reference.line - 1] ?? "").includes(reference.quote);
}

/** 这里只核验引用原文，不把文件名、相似度或引用格式有效当作理解了项目。 */
export async function recordImplementationBasis(binding: WorktreeBinding, head: string, basis: ImplementationBasisInput, acceptanceIds: string[]) {
  if (basis.decisions.some(item => !acceptanceIds.includes(item.acceptance_id))) {
    throw new AppError("IMPLEMENTATION_ACCEPTANCE_UNKNOWN", "实现决策必须关联本任务实际存在的验收项");
  }
  const before = await reviewSnapshot(binding, head), files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  for (const reference of basis.references) {
    try {
      if (!matchesReference(await safeSource(files, reference.path, config), reference)) throw new Error("原文或哈希不一致");
    } catch { throw new AppError("IMPLEMENTATION_REFERENCE_INVALID", `请实际读取并核对实现依据的路径、哈希及行文：${reference.path}`); }
  }
  // 避免引用读取期间代码变化，使记录的时机和快照与引用不属于同一工作树状态。
  if ((await reviewSnapshot(binding, head)).hash !== before.hash) throw new AppError("REVIEW_SNAPSHOT_CHANGED", "记录实现依据期间代码变化，请重新核对");
  return { basis, recorded_at: new Date().toISOString(), review_snapshot: before.hash,
    timing: before.paths.length ? "after_changes" as const : "before_changes" as const };
}

/** 所有实现决策共用这条复核路径；不针对某一种库、语言或设计模式设专用表单。 */
export async function implementationBasisReview(binding: WorktreeBinding, task: Task, snapshot: string) {
  const history = task.implementation_bases ?? [], record = history.at(-1), required = task.implementation_policy === 1 || !!record;
  const limitation = "核验的是原文依据、实现决策与当前验收记录；不证明语义理解或设计合理。记录时已有改动会如实标注，不伪装为编码前准备。";
  if (!record) return { state: required ? "missing" as const : "legacy" as const, required, basis_count: 0,
    references: [], decisions: [], limitation };
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files), references = [];
  for (const reference of record.basis.references) {
    let state: "current" | "task_baseline" | "stale" = "stale";
    if (!excluded(reference.path, config)) {
      try { if (matchesReference(await safeSource(files, reference.path, config), reference)) state = "current"; } catch { /* 删除或改写的原依据仍可核对任务基线。 */ }
      if (state === "stale") {
        try {
          // 引用路径仍经过安全边界核验；不跟随链接，不执行项目代码。基线只读固定对象的普通文件。
          await files.path(reference.path, true);
          await sourceBoundary(files, reference.path, config);
          const meta = (await readGit(binding.root, ["ls-tree", task.baseline_head, "--", `:(literal)${reference.path}`])).stdout.toString("utf8");
          if (/^100(?:644|755) blob [a-f0-9]+\t/.test(meta)) {
            const result = await readGit(binding.root, ["show", `${task.baseline_head}:${reference.path}`]);
            if (result.stdout.length <= MAX_SOURCE && matchesReference(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout), reference)) state = "task_baseline";
          }
        } catch { /* 无法核验不能当作依据有效。 */ }
      }
    }
    references.push({ id: reference.id, path: reference.path, state });
  }
  const decisions = record.basis.decisions.map(decision => {
    const criterion = task.acceptance_criteria.find(item => item.id === decision.acceptance_id);
    const state = !criterion || criterion.status !== "checked" ? "pending" : criterion.review_snapshot !== snapshot ? "stale" : "checked";
    return { id: decision.id, acceptance_id: decision.acceptance_id, reference_ids: decision.reference_ids, state };
  });
  const stale = references.some(item => item.state === "stale") || decisions.some(item => item.state === "stale");
  return { state: stale ? "stale" as const : decisions.some(item => item.state !== "checked") ? "pending" as const : "checked" as const,
    required, basis_count: history.length, timing: record.timing, first_timing: history[0]!.timing,
    references, decisions, ...(record.basis.absence_reason ? { absence_reason: record.basis.absence_reason } : {}), limitation };
}

export function assertImplementationBasis(review: Awaited<ReturnType<typeof implementationBasisReview>>): void {
  if (!review.required || review.state === "checked") return;
  throw new AppError(review.state === "missing" ? "IMPLEMENTATION_BASIS_REQUIRED" : "IMPLEMENTATION_BASIS_REVIEW_REQUIRED",
    "先建立并核对项目实现依据，将实际适用的约束和实现选择关联到验收；逐项复核后再关闭任务");
}
