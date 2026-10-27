import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import type { WorkspaceEntry } from "../domain/workspace-baseline.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";

/** 指纹只读链接自身，普通内容用 NOFOLLOW 读取并核对前后身份，拒绝读取中的变动。 */
export async function workspaceContent(
  files: ProjectFiles,
  relative: string,
  retain = false,
): Promise<{ entry: WorkspaceEntry; bytes: number; content?: Buffer }> {
  try {
    const parent = dirname(relative),
      path = join(
        parent === "." ? files.root : await files.path(parent),
        relative.split("/").at(-1)!,
      );
    const before = await lstat(path);
    if (before.isSymbolicLink())
      return {
        entry: {
          path: relative,
          kind: "symlink",
          target: await readlink(path),
        },
        bytes: 0,
      };
    if (!before.isFile())
      throw new AppError(
        "REVIEW_SNAPSHOT_UNSUPPORTED",
        `无法核验非普通文件：${relative}`,
      );
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const start = await handle.stat();
      if (
        !start.isFile() ||
        start.ino !== before.ino ||
        start.dev !== before.dev
      )
        throw new AppError("REVIEW_SNAPSHOT_CHANGED", "读取快照时文件身份变化");
      const hash = createHash("sha256"),
        chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = Buffer.alloc(65536);
        const result = await handle.read(chunk, 0, chunk.length, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > (retain ? 8 : 128) * 1024 * 1024)
          throw new AppError(
            "REVIEW_SNAPSHOT_LIMIT",
            retain
              ? "接入前单文件超过8 MiB，无法完整保留基线"
              : "审查文件超出128 MiB",
          );
        const data = chunk.subarray(0, result.bytesRead);
        hash.update(data);
        if (retain) chunks.push(data);
      }
      const end = await handle.stat(),
        current = await lstat(path);
      if (
        start.size !== end.size ||
        start.mtimeMs !== end.mtimeMs ||
        start.ctimeMs !== end.ctimeMs ||
        end.ino !== current.ino ||
        end.dev !== current.dev
      )
        throw new AppError("REVIEW_SNAPSHOT_CHANGED", "读取快照时内容变化");
      return {
        entry: {
          path: relative,
          kind: "file",
          mode: end.mode & 0o111,
          sha256: hash.digest("hex"),
        },
        bytes,
        ...(retain ? { content: Buffer.concat(chunks) } : {}),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasCode(error, "ENOENT"))
      return { entry: { path: relative, kind: "missing" }, bytes: 0 };
    throw error;
  }
}
export const entryIdentity = (entry: WorkspaceEntry) =>
  JSON.stringify([
    entry.kind,
    entry.sha256 ?? null,
    entry.mode ?? null,
    entry.target ?? null,
  ]);
