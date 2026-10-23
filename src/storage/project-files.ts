import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, realpath, mkdir, open, link, unlink, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../domain/error.js";
import { RelativePathSchema } from "../domain/common.js";

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Bounded project files. No symlinks, traversal, network reads, or external paths. */
export class ProjectFiles {
  constructor(readonly root: string) {}

  async path(relative: string, allowMissing = false): Promise<string> {
    RelativePathSchema.parse(relative);
    if (relative.split("/").includes(".git")) throw new AppError("PATH_UNSAFE", "Git 内部文件不能作为项目知识路径");
    if (await realpath(this.root) !== this.root || !(await lstat(this.root)).isDirectory()) {
      throw new AppError("PATH_UNSAFE", "项目根路径必须始终是实际目录");
    }
    let path = this.root;
    const parts = relative.split("/");
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]!);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
          throw new AppError("PATH_UNSAFE", `不支持符号链接或非目录路径：${relative}`);
        }
      } catch (error) {
        if (!(allowMissing && hasCode(error, "ENOENT"))) throw error;
      }
    }
    return path;
  }

  async read(relative: string, maximum = 32_768): Promise<string> {
    const path = await this.path(relative);
    if (!(await lstat(path)).isFile()) throw new AppError("PATH_UNSAFE", `该路径不是普通文件：${relative}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new AppError("PATH_UNSAFE", `该路径不是普通文件：${relative}`);
      if (info.size > maximum) throw new AppError("FILE_LIMIT", `文件超过 ${maximum} 字节限制：${relative}`);
      const data = Buffer.alloc(maximum + 1);
      let size = 0;
      while (size < data.length) {
        const { bytesRead } = await handle.read(data, size, data.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > maximum) throw new AppError("FILE_LIMIT", `文件超过 ${maximum} 字节限制：${relative}`);
      return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size));
    } finally { await handle.close(); }
  }

  async directory(relative: string): Promise<string> {
    await this.path(relative, true);
    let part = "";
    for (const segment of relative.split("/")) {
      part = part ? `${part}/${segment}` : segment;
      const path = await this.path(part, true);
      try { await mkdir(path, { mode: 0o700 }); } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      if (!(await lstat(await this.path(part))).isDirectory()) throw new AppError("PATH_UNSAFE", `Not a directory: ${part}`);
    }
    return this.path(relative);
  }

  /** Publish a complete new file atomically; existing content is never replaced. */
  async create(relative: string, content: string, maximum = 65_536): Promise<void> {
    await this.write(relative, content, undefined, maximum);
  }

  /** Used only by explicit local setup/review commands, not by MCP knowledge tools. */
  async replace(relative: string, content: string, previous: string): Promise<void> {
    await this.write(relative, content, previous);
  }

  private async write(relative: string, content: string, previous?: string, maximum = 65_536): Promise<void> {
    // 默认知识文件仍限制 64 KiB；只有内部运行记录显式申请有界的较大容量。
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_048_576 || Buffer.byteLength(content) > maximum) throw new AppError("FILE_LIMIT", `生成文件超过 ${maximum} 字节限制`);
    await this.path(relative, true);
    const parent = dirname(relative);
    if (parent !== ".") await this.directory(parent);
    const temporary = parent === "." ? `.project-dev-${randomUUID()}.tmp` : `${parent}/.write-${randomUUID()}.tmp`;
    const tempPath = await this.path(temporary, true);
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try {
      const target = await this.path(relative, true);
      if (previous === undefined) {
        try { await link(tempPath, target); } catch (error) {
          if (hasCode(error, "EEXIST")) throw new AppError("FILE_EXISTS", `已保留现有文件：${relative}`);
          throw error;
        }
      } else {
        if (await this.read(relative, 65_536) !== previous) throw new AppError("FILE_CHANGED", `更新过程中文件发生变化：${relative}`);
        await rename(tempPath, target);
      }
    } finally {
      try { await unlink(await this.path(temporary, true)); } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
  }
}
