import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../domain/error.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import type { WorktreeBinding } from "./baseline.js";
import { changedPaths } from "./changes.js";

/** 将审查绑定到实际内容。Git 基线代表未改文件，另对全部有效改动和未跟踪文件取指纹。 */
export async function reviewSnapshot(binding: WorktreeBinding, baseline: string): Promise<{ hash: string; paths: string[] }> {
  const paths = await changedPaths(binding, baseline);
  if (paths.length > 10_000) throw new AppError("REVIEW_SNAPSHOT_LIMIT", "审查快照涉及的文件超过 10000 个，请缩小任务范围");
  const files = new ProjectFiles(binding.root), hash = createHash("sha256");
  hash.update(JSON.stringify(["review-v1", baseline, paths]));
  let total = 0;
  for (const relative of paths) {
    const parent = dirname(relative);
    let path: string;
    try {
      path = join(parent === "." ? binding.root : await files.path(parent), relative.split("/").at(-1)!);
      const before = await lstat(path);
      if (before.isSymbolicLink()) {
        // 仅记录链接本身，绝不读取其指向的仓库外内容。
        hash.update(JSON.stringify([relative, "symlink", await readlink(path)]));
        continue;
      }
      if (!before.isFile()) throw new AppError("REVIEW_SNAPSHOT_UNSUPPORTED", `无法核验非普通文件：${relative}`);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const start = await handle.stat(), content = createHash("sha256"), buffer = Buffer.alloc(65_536);
        if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev) throw new AppError("REVIEW_SNAPSHOT_CHANGED", "生成审查快照时文件发生变化，请重新核验");
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > 128 * 1024 * 1024) throw new AppError("REVIEW_SNAPSHOT_LIMIT", "审查改动超过 128 MiB，请缩小任务范围");
          content.update(buffer.subarray(0, bytesRead));
        }
        const end = await handle.stat(), current = await lstat(path);
        if (start.size !== end.size || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || current.ino !== end.ino || current.dev !== end.dev) {
          throw new AppError("REVIEW_SNAPSHOT_CHANGED", "生成审查快照时文件发生变化，请重新核验");
        }
        hash.update(JSON.stringify([relative, "file", end.mode & 0o111, content.digest("hex")]));
      } finally { await handle.close(); }
    } catch (error) {
      if (hasCode(error, "ENOENT")) hash.update(JSON.stringify([relative, "missing"]));
      else throw error;
    }
  }
  if (JSON.stringify(paths) !== JSON.stringify(await changedPaths(binding, baseline))) throw new AppError("REVIEW_SNAPSHOT_CHANGED", "生成审查快照时改动列表发生变化，请重新核验");
  return { hash: hash.digest("hex"), paths };
}
