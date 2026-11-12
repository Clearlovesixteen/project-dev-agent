import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import { ProjectFiles } from "../storage/project-files.js";
import type { WorktreeBinding } from "./baseline.js";
import { changedPaths } from "./changes.js";
import type { WorkspaceBaseline } from "../domain/workspace-baseline.js";
import { entryIdentity, workspaceContent } from "./workspace-content.js";
import type { MergeRecovery } from "../domain/merge-recovery.js";
import { assertMergeRecovery } from "./merge-recovery.js";

/** 指纹覆盖完整有效工作区；任务路径另与接入内容比较，已有改动不冒充本轮成果。 */
export async function reviewSnapshot(
  binding: WorktreeBinding,
  baseline: string,
  initial?: WorkspaceBaseline,
  options: { recovery?: MergeRecovery; allow_unmerged?: boolean } = {},
) {
  const recovery = options.recovery ?? initial?.merge_recovery;
  const mergeState = recovery ? await assertMergeRecovery(binding, recovery) : undefined;
  const gitPaths = await changedPaths(binding, baseline, options.allow_unmerged ? recovery : undefined),
    paths = [
      ...new Set([
        ...gitPaths,
        ...(initial?.entries.map((item) => item.path) ?? []),
      ]),
    ].sort();
  if (paths.length > 10000)
    throw new AppError("REVIEW_SNAPSHOT_LIMIT", "审查快照超过10000个文件");
  const files = new ProjectFiles(binding.root),
    hash = createHash("sha256"),
    delta: string[] = [];
  let total = 0;
  hash.update(JSON.stringify(["review-v2", baseline, paths]));
  if (mergeState) hash.update(JSON.stringify(["merge-recovery-v1", mergeState]));
  for (const path of paths) {
    const { entry, bytes } = await workspaceContent(files, path);
    total += bytes;
    if (total > 128 * 1024 * 1024)
      throw new AppError("REVIEW_SNAPSHOT_LIMIT", "审查改动超过128 MiB");
    if (entry.kind === "file")
      hash.update(JSON.stringify([path, "file", entry.mode, entry.sha256]));
    else if (entry.kind === "symlink")
      hash.update(JSON.stringify([path, "symlink", entry.target]));
    else hash.update(JSON.stringify([path, "missing"]));
    const before = initial?.entries.find((item) => item.path === path);
    if (!before || entryIdentity(before) !== entryIdentity(entry))
      delta.push(path);
  }
  if (
    JSON.stringify(gitPaths) !==
    JSON.stringify(await changedPaths(binding, baseline, options.allow_unmerged ? recovery : undefined))
  )
    throw new AppError("REVIEW_SNAPSHOT_CHANGED", "快照期间改动列表变化");
  if (recovery && JSON.stringify(await assertMergeRecovery(binding, recovery)) !== JSON.stringify(mergeState))
    throw new AppError("REVIEW_SNAPSHOT_CHANGED", "快照期间合并身份或冲突 stages 变化");
  return {
    hash: hash.digest("hex"),
    paths: delta,
    all_paths: paths,
    preexisting_paths: initial?.entries.map((item) => item.path) ?? [],
  };
}
