import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import { ProjectFiles } from "../storage/project-files.js";
import type { WorktreeBinding } from "./baseline.js";
import { changedPaths } from "./changes.js";
import type { WorkspaceBaseline } from "../domain/workspace-baseline.js";
import { entryIdentity, workspaceContent } from "./workspace-content.js";

/** 指纹覆盖完整有效工作区；任务路径另与接入内容比较，已有改动不冒充本轮成果。 */
export async function reviewSnapshot(
  binding: WorktreeBinding,
  baseline: string,
  initial?: WorkspaceBaseline,
) {
  const gitPaths = await changedPaths(binding, baseline),
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
    JSON.stringify(await changedPaths(binding, baseline))
  )
    throw new AppError("REVIEW_SNAPSHOT_CHANGED", "快照期间改动列表变化");
  return {
    hash: hash.digest("hex"),
    paths: delta,
    all_paths: paths,
    preexisting_paths: initial?.entries.map((item) => item.path) ?? [],
  };
}
