import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import type { WorkspaceEntry } from "../domain/workspace-baseline.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";

// 仅保留摘要，不缓存文件正文、验收状态或“允许写入”。路径含工作树绝对位置。
const digests = new Map<string, { stamp: string; sha256: string }>();
const digestLimit = 2048;
function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join("/");
}

/** 在稳定且支持亚毫秒变更时间的本地文件上复用摘要；粗粒度、刚写完或不可靠的时间戳走字节核验。 */
function canReuse(stat: BigIntStats): boolean {
  return (process.platform === "darwin" || process.platform === "linux")
    && stat.ino !== 0n && stat.ctimeNs % 1_000_000n !== 0n
    && stat.ctimeNs < BigInt(Date.now() - 1000) * 1_000_000n;
}

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
    const before = await lstat(path, { bigint: true });
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
      const start = await handle.stat({ bigint: true });
      if (
        !start.isFile() ||
        start.ino !== before.ino ||
        start.dev !== before.dev
      )
        throw new AppError("REVIEW_SNAPSHOT_CHANGED", "读取快照时文件身份变化");
      const signature = stamp(start);
      const reusable = !retain && canReuse(start);
      const cached = reusable ? digests.get(path) : undefined;
      const hit = cached?.stamp === signature;
      const chunks: Buffer[] = [];
      let bytes = hit ? Number(start.size) : 0;
      let sha256 = hit ? cached.sha256 : "";
      if (!hit) {
        const hash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(65536);
        for (;;) {
          const result = await handle.read(chunk, 0, chunk.length, null);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
          if (bytes > (retain ? 8 : 128) * 1024 * 1024)
            throw new AppError("REVIEW_SNAPSHOT_LIMIT", retain ? "接入前单文件超过8 MiB，无法完整保留基线" : "审查文件超出128 MiB");
          const data = chunk.subarray(0, result.bytesRead);
          hash.update(data);
          if (retain) chunks.push(Buffer.from(data));
        }
        sha256 = hash.digest("hex");
      }
      const end = await handle.stat({ bigint: true }),
        current = await lstat(path, { bigint: true });
      if (
        stamp(end) !== signature || stamp(current) !== signature
      )
        throw new AppError("REVIEW_SNAPSHOT_CHANGED", "读取快照时内容变化");
      if (reusable && !hit) {
        if (!digests.has(path) && digests.size >= digestLimit) digests.delete(digests.keys().next().value!);
        digests.set(path, { stamp: signature, sha256 });
      }
      return {
        entry: {
          path: relative,
          kind: "file",
          mode: Number(end.mode & 0o111n),
          sha256,
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
