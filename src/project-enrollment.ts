import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import { bindWorktree } from "./git/index.js";
import { decodeGitOutput, gitLine, readGit } from "./git/command.js";
import { hasCode, ProjectFiles } from "./storage/project-files.js";
import { Workspace } from "./workspace.js";

export const AbsoluteProjectPath = z.string().min(1).max(4096).refine(isAbsolute);
export const EnrolledProject = z.object({
  root: AbsoluteProjectPath, requested_root: AbsoluteProjectPath, repo_identity: AbsoluteProjectPath,
  git_dir: AbsoluteProjectPath, git_file_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type EnrolledProject = z.infer<typeof EnrolledProject>;

const unsafe = () => new AppError("PROJECT_PATH_UNSAFE", "工作树的 Git 元数据未通过双向登记校验，不能自动接入");

/** 只读取当前根目录下普通 gitfile；拒绝符号链接，并限制读取大小。 */
async function readGitFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8_192) throw unsafe();
    const buffer = Buffer.alloc(8_193); let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > 8_192) throw unsafe();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await handle.close(); }
}

/** 登记精确工作树及元数据身份；linked worktree 必须有 Git 真实反向登记，不扩大任何父目录权限。 */
export async function inspectEnrolledProject(project: string) {
  let workspace: Workspace;
  try { workspace = await Workspace.open(project); }
  catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR"))
      throw new AppError("PROJECT_PATH_INVALID", "项目路径必须指向已存在的目录");
    throw error;
  }
  const binding = await bindWorktree(workspace.root);
  const dotGit = join(binding.root, ".git"), stat = await lstat(dotGit);
  if (stat.isSymbolicLink()) throw unsafe();
  const gitDir = await realpath(gitLine((await readGit(binding.root, ["rev-parse", "--absolute-git-dir"])).stdout));
  let fingerprint: string | null = null;
  if (stat.isDirectory()) {
    // 普通仓库只承认其自身 .git，不能借 core.worktree 或别处的元数据扩大范围。
    if (await realpath(dotGit) !== dotGit || gitDir !== dotGit || binding.repo_identity !== dotGit) throw unsafe();
  } else {
    if (!stat.isFile()) throw unsafe();
    const raw = await readGitFile(dotGit), pointer = /^gitdir: ([^\r\n]+)\n?$/.exec(raw)?.[1];
    if (!pointer || await realpath(resolve(binding.root, pointer)) !== gitDir
      || dirname(gitDir) !== join(binding.repo_identity, "worktrees")) throw unsafe();
    const metadata = new ProjectFiles(gitDir);
    const backPointer = (await metadata.read("gitdir", 8_192)).replace(/\n$/, "");
    const commonPointer = (await metadata.read("commondir", 8_192)).replace(/\n$/, "");
    if (resolve(gitDir, backPointer) !== dotGit || await realpath(resolve(gitDir, commonPointer)) !== binding.repo_identity) throw unsafe();
    const listed = decodeGitOutput((await readGit(binding.root, ["worktree", "list", "--porcelain", "-z"])).stdout)
      .split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
    if (!listed.includes(binding.root)) throw unsafe();
    fingerprint = createHash("sha256").update(raw).digest("hex");
  }
  return { binding, entry: { root: binding.root, requested_root: resolve(project), repo_identity: binding.repo_identity,
    git_dir: gitDir, git_file_sha256: fingerprint } satisfies EnrolledProject };
}

/** 每次工具调用重验原路径和 Git 双向关系；新路径、改指向和重新登记都不能沿用旧授权。 */
export async function bindEnrolledProject(entry: EnrolledProject, project: string) {
  const supplied = resolve(project);
  if (supplied !== entry.root && supplied !== entry.requested_root) throw new AppError("PROJECT_NOT_ENROLLED", "当前路径尚未接入");
  const workspace = await Workspace.open(entry.requested_root);
  if (workspace.root !== entry.root) throw new AppError("WORKSPACE_CHANGED", "已接入项目的原路径发生变化，请核对项目目录");
  const current = await inspectEnrolledProject(entry.requested_root);
  if (current.entry.root !== entry.root || current.entry.repo_identity !== entry.repo_identity
    || current.entry.git_dir !== entry.git_dir || current.entry.git_file_sha256 !== entry.git_file_sha256)
    throw new AppError("WORKSPACE_CHANGED", "已接入项目的 Git 仓库标识发生变化，请核对项目目录");
  return current.binding;
}
