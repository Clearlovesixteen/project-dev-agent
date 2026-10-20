import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { AppError } from "../domain/error.js";
import { ProjectFiles, hasCode } from "./project-files.js";

/** 原子发布锁信息；仅回收确认已退出的进程，未知持有者和权限错误保持锁定。 */
export async function acquireFileLock(files: ProjectFiles, path: string, busyCode: string, depth = 0): Promise<() => Promise<void>> {
  const busy = () => new AppError(busyCode, "其他进程正在修改记录，或无法确认遗留锁的持有者。请稍后重试或核对锁文件");
  if (depth > 8) throw busy();
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const read = async () => {
    try { return await files.read(path, 2_048); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  };
  const dead = (raw: string) => {
    try {
      const pid: unknown = JSON.parse(raw).pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); } catch (error) { return hasCode(error, "ESRCH"); }
    } catch { /* 旧版 pid 格式可恢复；无法解析的内容交由人工核对。 */ }
    return false;
  };
  const publish = async () => {
    try { await files.create(path, owner); return true; } catch (error) {
      if (error instanceof AppError && error.code === "FILE_EXISTS") return false;
      throw error;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await publish()) return async () => { if (await read() === owner) await unlink(await files.path(path)); };
    const existing = await read();
    if (existing === undefined) continue;
    if (!dead(existing)) throw busy();
    // 回收本身也串行化，避免两个恢复进程误删对方刚取得的锁；恢复锁也支持崩溃恢复。
    const releaseRecovery = await acquireFileLock(files, `${path}.recover`, busyCode, depth + 1);
    try {
      const latest = await read();
      if (latest !== undefined) {
        if (!dead(latest)) throw busy();
        await unlink(await files.path(path));
      }
      if (await publish()) return async () => { if (await read() === owner) await unlink(await files.path(path)); };
      throw busy();
    } finally { await releaseRecovery(); }
  }
  throw busy();
}
