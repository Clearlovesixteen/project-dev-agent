import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AppError } from "../domain/error.js";
import { RelativePathSchema } from "../domain/common.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode } from "../storage/project-files.js";
import { ProjectIdentitySchema, PROJECT_KNOWLEDGE_DIR, SnapshotPointerSchema, type ProjectIdentity, type SnapshotPointer } from "./contracts.js";

const MAX_FILE = 1_048_576;
const unsafe = (message: string) => new AppError("PROJECT_KNOWLEDGE_PATH_UNSAFE", message);

/** 只允许访问一个已经由 Git common-dir 定位的插件专属目录。 */
export class RepositoryFiles {
  readonly root: string;
  private constructor(readonly commonDir: string) { this.root = join(commonDir, PROJECT_KNOWLEDGE_DIR); }

  static async open(commonDir: string): Promise<RepositoryFiles> {
    const actual = await realpath(commonDir).catch(() => { throw unsafe("Git 公共目录必须是实际目录"); });
    if (!(await lstat(actual)).isDirectory()) throw unsafe("Git 公共目录必须是目录");
    const files = new RepositoryFiles(actual);
    await files.ensureRoot();
    return files;
  }

  private async ensureRoot(): Promise<void> {
    try {
      const info = await lstat(this.root);
      if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe("项目知识库目录不能是符号链接或普通文件");
      if (await realpath(this.root) !== this.root) throw unsafe("项目知识库目录必须保持在 Git 公共目录下");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      try { await mkdir(this.root, { recursive: false, mode: 0o700 }); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      const created = await lstat(this.root);
      if (created.isSymbolicLink() || !created.isDirectory() || await realpath(this.root) !== this.root) throw unsafe("项目知识库目录不能是符号链接或普通文件");
    }
    for (const directory of ["objects", "transactions", "operations", "migrations"]) await this.ensureDirectory(directory);
  }

  private async ensureDirectory(relativePath: string): Promise<string> {
    const path = await this.path(relativePath, true);
    try { await mkdir(path, { recursive: false, mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) throw unsafe(`知识库目录不安全：${relativePath}`);
    return path;
  }

  async path(relativePath: string, allowMissing = false): Promise<string> {
    RelativePathSchema.parse(relativePath);
    if (relativePath.split("/").includes(".git")) throw unsafe("知识库不能访问 Git 内部路径");
    const root = await realpath(this.root).catch(() => { throw unsafe("项目知识库目录不存在"); });
    if (root !== this.root) throw unsafe("项目知识库目录路径发生变化");
    let current = this.root;
    for (const [index, segment] of relativePath.split("/").entries()) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (index < relativePath.split("/").length - 1 && !info.isDirectory())) throw unsafe(`知识库路径不安全：${relativePath}`);
      } catch (error) {
        if (!(allowMissing && hasCode(error, "ENOENT"))) throw error;
      }
    }
    const resolvedParent = resolve(dirname(current));
    const rootRelative = relative(this.root, resolvedParent);
    if (rootRelative.startsWith("..") || rootRelative.includes("/../")) throw unsafe("知识库路径越界");
    return current;
  }

  async read(relativePath: string, maximum = MAX_FILE): Promise<string> {
    const path = await this.path(relativePath);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximum) throw new AppError("PROJECT_KNOWLEDGE_FILE_LIMIT", `知识库文件超过 ${maximum} 字节`);
      return await handle.readFile({ encoding: "utf8" });
    } finally { await handle.close(); }
  }

  async create(relativePath: string, content: string, maximum = MAX_FILE): Promise<void> {
    if (Buffer.byteLength(content) > maximum) throw new AppError("PROJECT_KNOWLEDGE_FILE_LIMIT", `知识库文件超过 ${maximum} 字节`);
    const target = await this.path(relativePath, true);
    const parent = dirname(relativePath);
    if (parent !== ".") await this.ensureDirectory(parent);
    const temporaryRelative = `${parent === "." ? "" : `${parent}/`}.write-${randomUUID()}.tmp`;
    const temporary = await this.path(temporaryRelative, true);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await (await import("node:fs/promises")).link(temporary, target); }
    catch (error) {
      if (hasCode(error, "EEXIST")) throw new AppError("FILE_EXISTS", `知识库对象已存在：${relativePath}`);
      throw error;
    } finally { try { await unlink(temporary); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; } }
  }

  async replace(relativePath: string, content: string, previous: string, maximum = MAX_FILE): Promise<void> {
    if (Buffer.byteLength(content) > maximum) throw new AppError("PROJECT_KNOWLEDGE_FILE_LIMIT", `知识库文件超过 ${maximum} 字节`);
    const target = await this.path(relativePath);
    if (await this.read(relativePath, maximum) !== previous) throw new AppError("PROJECT_KNOWLEDGE_CHANGED", `知识库文件已变化：${relativePath}`);
    const parent = dirname(relativePath);
    const temporaryRelative = `${parent === "." ? "" : `${parent}/`}.write-${randomUUID()}.tmp`;
    const temporary = await this.path(temporaryRelative, true);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, target); }
    finally { try { await unlink(temporary); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; } }
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // file-lock 的基础语义是拒绝活锁；项目库在其外层做有界退避，让两个独立 MCP 进程可以短暂排队。
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const release = await acquireFileLock(this as unknown as import("../storage/project-files.js").ProjectFiles, "writer.lock", "PROJECT_KNOWLEDGE_BUSY");
        try { return await operation(); } finally { await release(); }
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "PROJECT_KNOWLEDGE_BUSY" || attempt === 99) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    throw new AppError("PROJECT_KNOWLEDGE_BUSY", "知识库写入等待超时");
  }

  async readIdentity(): Promise<ProjectIdentity | undefined> {
    try { return ProjectIdentitySchema.parse(JSON.parse(await this.read("identity.json", 16_384))); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }

  async ensureIdentity(repoIdentity: string): Promise<ProjectIdentity> {
    return this.withLock(async () => {
      const current = await this.readIdentity();
      if (current) {
        if (current.repo_identity !== repoIdentity) throw new AppError("PROJECT_KNOWLEDGE_IDENTITY_MISMATCH", "知识库已绑定其他 Git 公共目录");
        return current;
      }
      const identity: ProjectIdentity = { schema_version: 1, protocol_version: 1, project_id: createHash("sha256").update(`${repoIdentity}\nproject-dev-agent\n`).digest("hex"), repo_identity: repoIdentity, created_at: new Date().toISOString() };
      await this.create("identity.json", JSON.stringify(identity));
      return identity;
    });
  }

  async readCurrent(): Promise<SnapshotPointer | undefined> {
    try { return SnapshotPointerSchema.parse(JSON.parse(await this.read("CURRENT.json", 32_768))); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }

  async writeObject(objectId: string, content: string): Promise<void> {
    await this.create(`objects/${objectId}.json`, content);
  }

  async commitCurrent(pointer: SnapshotPointer, transactionContent: string): Promise<void> {
    const txPath = `transactions/${pointer.transaction_id}.json`;
    await this.create(txPath, transactionContent);
    const current = JSON.stringify(pointer);
    const existing = await this.read("CURRENT.json").catch((error) => hasCode(error, "ENOENT") ? undefined : Promise.reject(error));
    if (existing === undefined) await this.create("CURRENT.json", current);
    else await this.replace("CURRENT.json", current, existing);
  }
}
