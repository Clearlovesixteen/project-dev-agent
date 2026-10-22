import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, opendir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { AppError } from "../domain/error.js";
import { IdSchema } from "../domain/common.js";
import { TaskSchema, type Task } from "../domain/task.js";

const MAX_RECORD_BYTES = 1_000_000;
const MAX_TASK_ENTRIES = 1_000;
const IMMUTABLE_FIELDS = [
  "id", "schema_version", "repo_identity", "worktree_path", "baseline_head", "baseline_branch", "created_at",
] as const;

interface StatePaths { root: string; local: string; tasks: string }
interface LockOwner { pid: number; token: string }

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function parseTask(input: unknown): Task {
  const result = TaskSchema.safeParse(input);
  if (!result.success) {
    throw new AppError("INVALID_TASK", `任务数据格式无效：${result.error.message}`);
  }
  return result.data;
}

function taskId(value: string): string {
  const result = IdSchema.safeParse(value);
  if (!result.success) throw new AppError("INVALID_TASK_ID", "任务 ID 不是有效且安全的记录标识");
  return result.data;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but is owned by another user.
    if (hasCode(error, "ESRCH")) return false;
    if (hasCode(error, "EPERM")) return true;
    throw new AppError("STORE_BUSY", "无法确认锁的持有进程是否仍在运行");
  }
}

/** Local, bounded JSON storage. Mutations are serialized across processes. */
export class TaskStore {
  private readonly requestedRoot: string;
  private boundRoot: string | undefined;

  constructor(root: string) {
    if (!root.trim()) throw new AppError("STATE_PATH_UNSAFE", "必须提供已绑定的项目根目录");
    this.requestedRoot = resolve(root);
  }

  async create(task: Task): Promise<Task> {
    const candidate = parseTask(task);
    taskId(candidate.id);
    return this.withLock(async (paths) => {
      this.assertBinding(candidate, paths.root);
      const target = join(paths.tasks, `${candidate.id}.json`);
      if (await this.recordExists(target)) throw new AppError("TASK_EXISTS", `任务 ${candidate.id} 已存在`);
      const directory = await opendir(paths.tasks);
      let count = 0;
      for await (const entry of directory) {
        if (++count > MAX_TASK_ENTRIES) throw new AppError("STATE_LIMIT", "任务目录中的记录数量超过限制");
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        taskId(id);
        const existing = await this.readTask(join(paths.tasks, entry.name));
        if (existing.id !== id) throw new AppError("STATE_CORRUPT", "保存的任务 ID 与文件名不一致");
        if (existing.phase === "active") {
          throw new AppError("ACTIVE_TASK_EXISTS", `任务 ${existing.id} 仍是当前项目的活跃任务`);
        }
      }
      await this.writeTask(paths, candidate, false);
      return structuredClone(candidate);
    });
  }

  async load(id: string): Promise<Task> {
    const safeId = taskId(id);
    const paths = await this.prepare(false);
    const task = await this.readTask(join(paths.tasks, `${safeId}.json`));
    if (task.id !== safeId) throw new AppError("STATE_CORRUPT", "保存的任务 ID 与文件名不一致");
    this.assertBinding(task, paths.root);
    return task;
  }

  /** 只读、限量列出本工作树任务，供效果统计使用；截断时不能声称覆盖全部项目历史。 */
  async list(limit = 100): Promise<{ tasks: Task[]; truncated: boolean }> {
    let paths: StatePaths;
    try { paths = await this.prepare(false); } catch (error) {
      if (error instanceof AppError && error.code === "TASK_NOT_FOUND") return { tasks: [], truncated: false };
      throw error;
    }
    const tasks: Task[] = [];
    const directory = await opendir(paths.tasks);
    let count = 0;
    for await (const entry of directory) {
      if (++count > MAX_TASK_ENTRIES) return { tasks, truncated: true };
      if (!entry.name.endsWith(".json")) continue;
      if (tasks.length >= limit) return { tasks, truncated: true };
      const id = taskId(entry.name.slice(0, -5));
      const task = await this.readTask(join(paths.tasks, entry.name));
      if (task.id !== id) throw new AppError("STATE_CORRUPT", "保存的任务 ID 与文件名不一致");
      this.assertBinding(task, paths.root); tasks.push(task);
    }
    return { tasks, truncated: false };
  }

  async active(): Promise<Task | undefined> {
    let paths: StatePaths;
    try { paths = await this.prepare(false); } catch (error) {
      if (error instanceof AppError && error.code === "TASK_NOT_FOUND") return undefined;
      throw error;
    }
    const directory = await opendir(paths.tasks);
    let count = 0;
    let active: Task | undefined;
    for await (const entry of directory) {
      if (++count > MAX_TASK_ENTRIES) throw new AppError("STATE_LIMIT", "任务目录中的记录数量超过限制");
      if (!entry.name.endsWith(".json")) continue;
      const id = taskId(entry.name.slice(0, -5));
      const task = await this.readTask(join(paths.tasks, entry.name));
      if (task.id !== id) throw new AppError("STATE_CORRUPT", "保存的任务 ID 与文件名不一致");
      this.assertBinding(task, paths.root);
      if (task.phase !== "active") continue;
      if (active) throw new AppError("MULTIPLE_ACTIVE_TASKS", "存在多个活跃任务，请显式指定任务 ID 并人工核对");
      active = task;
    }
    return active;
  }

  async update(id: string, expectedRevision: number, mutator: (current: Task) => Task | Promise<Task>): Promise<Task> {
    const safeId = taskId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new AppError("REVISION_CONFLICT", "预期修订号必须是非负安全整数");
    }
    return this.withLock(async (paths) => {
      const current = await this.readTask(join(paths.tasks, `${safeId}.json`));
      if (current.id !== safeId) throw new AppError("STATE_CORRUPT", "保存的任务 ID 与文件名不一致");
      this.assertBinding(current, paths.root);
      if (current.phase !== "active") throw new AppError("TASK_READ_ONLY", `任务 ${safeId} 的状态为 ${current.phase}，不能继续修改`);
      if (current.revision !== expectedRevision) {
        throw new AppError("REVISION_CONFLICT", `预期修订号为 ${expectedRevision}，实际为 ${current.revision}`);
      }
      const candidate = parseTask(await mutator(structuredClone(current)));
      for (const field of IMMUTABLE_FIELDS) {
        if (candidate[field] !== current[field]) {
          throw new AppError("IMMUTABLE_TASK_FIELD", `任务字段 ${field} 不允许修改`);
        }
      }
      if (JSON.stringify(candidate.evaluation) !== JSON.stringify(current.evaluation)) {
        throw new AppError("IMMUTABLE_TASK_FIELD", "评测分组属于初始任务定义，不能事后改组或移除");
      }
      if (JSON.stringify(candidate.implementation_baseline) !== JSON.stringify(current.implementation_baseline)) {
        throw new AppError("IMMUTABLE_TASK_FIELD", "项目公共能力基线由任务创建时捕获，不能事后改写");
      }
      const next = parseTask({ ...candidate, revision: current.revision + 1, updated_at: new Date().toISOString() });
      await this.writeTask(paths, next, true);
      return structuredClone(next);
    });
  }

  private assertBinding(task: Task, root: string): void {
    if (resolve(task.worktree_path) !== root) {
      throw new AppError("STATE_PATH_UNSAFE", "任务工作树与当前绑定的项目根目录不一致");
    }
  }

  private async prepare(create: boolean): Promise<StatePaths> {
    const rootEntry = await lstat(this.requestedRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw new AppError("STATE_PATH_UNSAFE", "项目根路径必须是实际目录");
    }
    const root = await realpath(this.requestedRoot);
    if (this.boundRoot !== undefined && this.boundRoot !== root) {
      throw new AppError("STATE_PATH_UNSAFE", "已绑定的项目根目录标识发生变化");
    }
    this.boundRoot = root;
    const knowledge = join(root, ".project-dev");
    const local = join(knowledge, "local");
    const tasks = join(local, "tasks");
    for (const path of [knowledge, local, tasks]) {
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new AppError("STATE_PATH_UNSAFE", "状态路径只能包含实际目录");
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        if (!create) throw new AppError("TASK_NOT_FOUND", "当前项目尚无任务记录");
        try { await mkdir(path, { mode: 0o700 }); } catch (mkdirError) {
          if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
        }
        const created = await lstat(path);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new AppError("STATE_PATH_UNSAFE", "状态路径只能包含实际目录");
        }
      }
    }
    return { root, local, tasks };
  }

  private async recordExists(path: string): Promise<boolean> {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new AppError("STATE_PATH_UNSAFE", "状态记录必须是普通文件");
      }
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async readText(path: string, maximum: number): Promise<string> {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new AppError("STATE_PATH_UNSAFE", "状态记录必须是普通文件");
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new AppError("STATE_PATH_UNSAFE", "状态记录必须是普通文件");
        if (info.size > maximum) throw new AppError("STATE_LIMIT", "状态记录大小超过限制");
        const buffer = Buffer.alloc(maximum + 1);
        let size = 0;
        while (size < buffer.length) {
          const chunk = await handle.read(buffer, size, buffer.length - size, null);
          if (chunk.bytesRead === 0) break;
          size += chunk.bytesRead;
        }
        if (size > maximum) throw new AppError("STATE_LIMIT", "状态记录大小超过限制");
        return buffer.subarray(0, size).toString("utf8");
      } finally { await handle.close(); }
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new AppError("TASK_NOT_FOUND", "状态记录不存在");
      if (hasCode(error, "ELOOP")) throw new AppError("STATE_PATH_UNSAFE", "不支持符号链接形式的状态记录");
      throw error;
    }
  }

  private async readTask(path: string): Promise<Task> {
    const text = await this.readText(path, MAX_RECORD_BYTES);
    try { return parseTask(JSON.parse(text) as unknown); } catch (error) {
      throw new AppError("STATE_CORRUPT", `已保存的任务记录无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeTask(paths: StatePaths, task: Task, replace: boolean): Promise<void> {
    const data = `${JSON.stringify(parseTask(task), null, 2)}\n`;
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new AppError("STATE_LIMIT", "任务记录大小超过限制");
    await this.prepare(false);
    const target = join(paths.tasks, `${taskId(task.id)}.json`);
    if (await this.recordExists(target) && !replace) throw new AppError("TASK_EXISTS", `任务 ${task.id} 已存在`);
    const temporary = join(paths.tasks, `.write-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await this.prepare(false);
      await this.recordExists(target);
      await rename(temporary, target);
    } finally {
      // Recheck the state path before removing a temporary file.
      try { await this.prepare(false); await unlink(temporary); } catch (error) {
        if (!hasCode(error, "ENOENT") && !(error instanceof AppError && error.code === "STATE_PATH_UNSAFE")) throw error;
      }
    }
  }

  private async withLock<T>(operation: (paths: StatePaths) => Promise<T>): Promise<T> {
    const paths = await this.prepare(true);
    const release = await this.acquireLock(paths, join(paths.local, ".task-store.lock"), 0);
    try { await this.prepare(false); return await operation(paths); } finally { await release(); }
  }

  private async readOwner(path: string): Promise<LockOwner | undefined> {
    let text: string;
    try { text = await this.readText(path, 2_048); } catch (error) {
      if (error instanceof AppError && error.code === "TASK_NOT_FOUND") return undefined;
      throw error;
    }
    try {
      const value = JSON.parse(text) as Partial<LockOwner>;
      if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.token !== "string"
        || !/^[0-9a-f-]{36}$/.test(value.token)) throw new Error("锁的持有者信息无效");
      return value as LockOwner;
    } catch {
      throw new AppError("STATE_CORRUPT", "存储锁的持有者信息无效，需要人工核对");
    }
  }

  private async acquireLock(paths: StatePaths, path: string, depth: number): Promise<() => Promise<void>> {
    if (depth > 8) throw new AppError("STORE_BUSY", "遗留锁恢复的嵌套层数超过限制");
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    const temporary = join(paths.local, `.lock-owner-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(owner), "utf8"); } finally { await handle.close(); }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.prepare(false);
        try {
          // Hard linking publishes a complete owner record atomically, without an empty-lock window.
          await link(temporary, path);
          return async () => {
            await this.prepare(false);
            const current = await this.readOwner(path);
            if (current?.token === owner.token) await unlink(path);
          };
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
        const existing = await this.readOwner(path);
        if (existing === undefined) continue;
        if (processAlive(existing.pid)) throw new AppError("STORE_BUSY", "其他进程正在修改任务记录");
        // Serialize stale-lock reclamation too. A crashed reclaimer can itself be recovered.
        const releaseRecovery = await this.acquireLock(paths, `${path}.recover`, depth + 1);
        try {
          const latest = await this.readOwner(path);
          if (latest !== undefined) {
            if (processAlive(latest.pid)) throw new AppError("STORE_BUSY", "其他进程已取得任务记录的写入锁");
            await unlink(path);
          }
        } finally { await releaseRecovery(); }
      }
      throw new AppError("STORE_BUSY", "获取锁期间任务记录多次变化，请核对后重试");
    } finally {
      await this.prepare(false);
      await unlink(temporary);
    }
  }
}
