import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import { RelativePathSchema } from "../domain/common.js";
import type { WorktreeBinding } from "../git/baseline.js";
import { decodeGitOutput, gitLine, readGit } from "../git/command.js";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const EXCLUDED_SEGMENTS = new Set([".git", ".project-dev", "node_modules"]);

export const SourceEntrySchema = z.object({
  path: z.string().min(1), kind: z.enum(["file", "missing", "symlink", "unreadable"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bytes: z.number().int().nonnegative(),
  status: z.array(z.enum(["tracked", "staged", "unstaged", "untracked", "deleted", "renamed"])).max(6),
  target: z.string().optional(), error: z.enum(["file_limit", "permission", "unsupported"]).optional(),
}).strict();
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export const SourceStampSchema = z.object({
  schema_version: z.literal(1), repo_identity: z.string().min(1), worktree_root: z.string().min(1), head: z.string().regex(/^[a-f0-9]{40,64}$/),
  entries: z.array(SourceEntrySchema).max(MAX_FILES),
  configuration: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(200),
  status: z.object({ staged: z.number().int().nonnegative(), unstaged: z.number().int().nonnegative(), untracked: z.number().int().nonnegative(), deleted: z.number().int().nonnegative(), renamed: z.number().int().nonnegative() }).strict(),
  coverage: z.object({ discovered: z.number().int().nonnegative(), read: z.number().int().nonnegative(), unreadable: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), complete: z.boolean() }).strict(),
  stamp_id: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SourceStamp = z.infer<typeof SourceStampSchema>;

type StatusKind = "tracked" | "staged" | "unstaged" | "untracked" | "deleted" | "renamed";
interface StatusItem { path: string; kinds: StatusKind[]; }
interface Capture { stamp: Omit<SourceStamp, "stamp_id">; signature: string; }

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function nulFields(output: Buffer): string[] {
  if (output.length === 0) return [];
  const text = decodeGitOutput(output);
  if (!text.endsWith("\0")) throw new AppError("GIT_OUTPUT_INVALID", "Git 路径输出应以空字符结尾");
  return text.slice(0, -1).split("\0");
}

function addPath(paths: Set<string>, candidate: string): void {
  if (!RelativePathSchema.safeParse(candidate).success) throw new AppError("INVALID_REPOSITORY_PATH", "Git 返回了不支持或不安全的仓库相对路径");
  paths.add(candidate);
}

function excluded(path: string): boolean { return path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment)); }

function parseStatus(output: Buffer): { items: StatusItem[]; excludedCount: number } {
  const fields = nulFields(output), items = new Map<string, Set<StatusKind>>();
  let excludedCount = 0;
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record || record.length < 3 || record[2] !== " ") throw new AppError("GIT_OUTPUT_INVALID", "Git 状态记录无效");
    const x = record[0]!, y = record[1]!, firstPath = record.slice(3);
    const paths = [firstPath];
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const newPath = fields[index++];
      if (!newPath) throw new AppError("GIT_OUTPUT_INVALID", "Git 重命名记录缺少目标路径");
      paths.push(newPath);
    }
    for (const path of paths) {
      if (excluded(path)) { excludedCount++; continue; }
      addPath(new Set(), path);
      const kinds = items.get(path) ?? new Set<StatusKind>();
      if (x !== " " && x !== "?") kinds.add("staged");
      if (y !== " " && y !== "?") kinds.add("unstaged");
      if (x === "?" && y === "?") kinds.add("untracked");
      if (x === "D" || y === "D") kinds.add("deleted");
      if (x === "R" || y === "R") kinds.add("renamed");
      if (x !== "?" && y !== "?" && kinds.size === 0) kinds.add("tracked");
      items.set(path, kinds);
    }
  }
  return { items: [...items].map(([path, kinds]) => ({ path, kinds: [...kinds] })).sort((a, b) => a.path.localeCompare(b.path)), excludedCount };
}

async function candidatePaths(binding: WorktreeBinding): Promise<{ paths: string[]; statuses: Map<string, StatusKind[]>; statusRaw: Buffer; excludedCount: number }> {
  const statusRaw = (await readGit(binding.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout;
  const parsed = parseStatus(statusRaw), paths = new Set<string>(parsed.items.map((item) => item.path));
  const tracked = nulFields((await readGit(binding.root, ["ls-files", "-z"])).stdout);
  const untracked = nulFields((await readGit(binding.root, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
  for (const path of [...tracked, ...untracked]) { if (excluded(path)) continue; addPath(paths, path); }
  const diff = nulFields((await readGit(binding.root, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", binding.head, "--"])).stdout);
  for (let index = 0; index < diff.length;) {
    const status = diff[index++]; const path = diff[index++];
    if (!status || !path) throw new AppError("GIT_OUTPUT_INVALID", "Git 差异记录无效");
    if (!excluded(path)) addPath(paths, path);
    if (status.startsWith("R") || status.startsWith("C")) { const destination = diff[index++]; if (!destination) throw new AppError("GIT_OUTPUT_INVALID", "Git 重命名差异缺少目标路径"); if (!excluded(destination)) addPath(paths, destination); }
  }
  if (paths.size > MAX_FILES) throw new AppError("SOURCE_STAMP_LIMIT", `当前工作树超过 ${MAX_FILES} 个可读文件`);
  return { paths: [...paths].sort(), statuses: new Map(parsed.items.map((item) => [item.path, item.kinds])), statusRaw, excludedCount: parsed.excludedCount };
}

async function readEntry(root: string, path: string, status: StatusKind[], total: { bytes: number }): Promise<SourceEntry> {
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (!isAbsolute(root) || rel.startsWith("..") || rel.includes("/../")) throw new AppError("PATH_UNSAFE", "来源路径超出工作树");
  try {
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) return SourceEntrySchema.parse({ path, kind: "symlink", sha256: null, bytes: 0, status, target: await readlink(absolute) });
    if (!before.isFile()) return SourceEntrySchema.parse({ path, kind: "unreadable", sha256: null, bytes: 0, status, error: "unsupported" });
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return SourceEntrySchema.parse({ path, kind: "unreadable", sha256: null, bytes: 0, status, error: "file_limit" });
      const hash = createHash("sha256"); let bytes = 0;
      for (;;) {
        const buffer = Buffer.alloc(64 * 1024), result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead; total.bytes += result.bytesRead;
        if (total.bytes > MAX_TOTAL_BYTES) return SourceEntrySchema.parse({ path, kind: "unreadable", sha256: null, bytes: 0, status, error: "file_limit" });
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await lstat(absolute);
      if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new AppError("VIEW_CHANGED", "读取来源期间文件发生变化");
      return SourceEntrySchema.parse({ path, kind: "file", sha256: hash.digest("hex"), bytes, status });
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return SourceEntrySchema.parse({ path, kind: "missing", sha256: null, bytes: 0, status });
    if (code === "EACCES" || code === "EPERM") return SourceEntrySchema.parse({ path, kind: "unreadable", sha256: null, bytes: 0, status, error: "permission" });
    throw error;
  }
}

function configurationPath(path: string): boolean { return /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig(?:\.[^/]+)?\.json)$/.test(path); }

async function capture(binding: WorktreeBinding): Promise<Capture> {
  const beforeHead = gitLine((await readGit(binding.root, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout);
  const candidates = await candidatePaths(binding), total = { bytes: 0 }, entries: SourceEntry[] = [];
  for (const path of candidates.paths) entries.push(await readEntry(binding.root, path, candidates.statuses.get(path) ?? ["tracked"], total));
  const status = { staged: 0, unstaged: 0, untracked: 0, deleted: 0, renamed: 0 };
  for (const entry of entries) for (const kind of entry.status) if (kind in status) status[kind as keyof typeof status]++;
  const configuration = entries.filter((entry) => configurationPath(entry.path)).map((entry) => ({ path: entry.path, sha256: entry.sha256 }));
  const stampWithoutId = SourceStampSchema.omit({ stamp_id: true }).parse({ schema_version: 1, repo_identity: binding.repo_identity, worktree_root: binding.root, head: beforeHead, entries, configuration, status, coverage: { discovered: candidates.paths.length, read: entries.filter((entry) => entry.kind === "file").length, unreadable: entries.filter((entry) => entry.kind === "unreadable").length, excluded: candidates.excludedCount, bytes: total.bytes, complete: entries.every((entry) => entry.kind !== "unreadable") } });
  const signature = digest(JSON.stringify({ head: beforeHead, status: digest(candidates.statusRaw), paths: entries.map((entry) => [entry.path, entry.kind, entry.sha256, entry.target]) }));
  return { stamp: stampWithoutId, signature };
}

export async function collectSourceStamp(binding: WorktreeBinding, options: { onCaptured?: () => Promise<void> | void } = {}): Promise<SourceStamp> {
  const first = await capture(binding);
  await options.onCaptured?.();
  const second = await capture(binding);
  if (first.signature !== second.signature || JSON.stringify(first.stamp.entries) !== JSON.stringify(second.stamp.entries)) throw new AppError("VIEW_CHANGED", "生成源码视图期间工作树发生变化，请重新读取");
  const stamp = { ...first.stamp, stamp_id: digest(JSON.stringify(first.stamp)) };
  return SourceStampSchema.parse(stamp);
}

