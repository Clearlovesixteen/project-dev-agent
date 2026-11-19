import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "../domain/error.js";
import { bindWorktree } from "../git/index.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import type { NativeHookInput } from "./contracts.js";
import { hookProject } from "./project.js";
import { patchPaths, shellWritePaths } from "./tool-policy.js";

function within(root: string, path: string): string | undefined {
  const value = relative(root, path);
  return !value || value === ".." || value.startsWith(".." + sep) || isAbsolute(value) ? undefined : value.split(sep).join("/");
}

/** 找到目标最近的 Git 边界；新建、删除和重命名后文件本身可能不存在。 */
async function gitDirectory(directory: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  const visited: string[] = [];
  let current = directory;
  while (!cache.has(current)) {
    try {
      await lstat(join(current, ".git"));
      cache.set(current, current);
      break;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    visited.push(current);
    const parent = dirname(current);
    if (parent === current) { cache.set(current, undefined); break; }
    current = parent;
  }
  const result = cache.get(current);
  for (const path of visited) cache.set(path, result);
  return result;
}

/** 修改前后按同一组目标定位；显式工具目录优先，隐式切换只允许一个已核验的同仓库工作树。 */
export async function resolveWriteTargets(input: NativeHookInput, workdir: string, baseProject: string) {
  const paths = input.tool_name === "Bash" || input.tool_name === "exec_command" || input.tool_name === "shell_command" || input.tool_name === "shell"
    ? shellWritePaths(input) ?? [] : patchPaths(input);
  if (!paths.length) return { project: baseProject, paths: [] };
  const directories = new Map<string, string | undefined>();
  const verifiedRoots = new Map<string, string>();
  const projects = new Map<string, Set<string>>();
  const workdirAlias = await gitDirectory(workdir, directories);
  for (const path of paths) {
    if (path.includes("\u0000") || path.split(/[\\/]/).includes(".."))
      throw new AppError("WRITE_TARGET_UNSAFE", "补丁目标使用了父目录跳转或无效字符。请使用实际工作树中的明确路径。");
    const absolute = resolve(workdir, path);
    const rootAlias = await gitDirectory(dirname(absolute), directories);
    if (!rootAlias) throw new AppError("WRITE_PROJECT_MISMATCH", "补丁目标不属于已核验的 Git 仓库。");
    let root = verifiedRoots.get(rootAlias);
    if (!root) {
      if ((await lstat(rootAlias)).isSymbolicLink())
        throw new AppError("WRITE_TARGET_UNSAFE", "补丁目标通过目录链接引用工作树。请使用目标工作树的实际路径。");
      root = await realpath(rootAlias);
      verifiedRoots.set(rootAlias, root);
    }
    const target = within(rootAlias, absolute);
    if (!target) throw new AppError("WRITE_TARGET_UNSAFE", "无法确定补丁在工作树内的相对位置。");

    // macOS 系统目录别名可以在工作树外。工作树内的文件名和目录仍须经过链接与边界检查。
    const nested = workdirAlias ? within(workdirAlias, rootAlias) : undefined;
    try {
      if (nested) await new ProjectFiles(baseProject).path(nested);
      await new ProjectFiles(root).path(target, true);
    } catch {
      throw new AppError("WRITE_TARGET_UNSAFE", "补丁目标包含符号链接、Git 内部路径或无法核验的目录。");
    }
    const targets = projects.get(root) ?? new Set<string>();
    targets.add(target);
    projects.set(root, targets);
  }
  if (projects.size !== 1)
    throw new AppError("WRITE_WORKTREE_MISMATCH", "一次补丁包含多个 Git 工作树。请按目标工作树分别执行。");
  const [project, targets] = projects.entries().next().value!;
  if (project !== baseProject) {
    const validated = await hookProject(project);
    const [current, destination] = await Promise.all([bindWorktree(baseProject), bindWorktree(validated)]);
    if (validated !== project || current.repo_identity !== destination.repo_identity)
      throw new AppError("WRITE_PROJECT_MISMATCH", "补丁目标属于另一个 Git 仓库。请在目标项目的会话或明确工作目录中准备后修改。");
  }
  return { project, paths: [...targets] };
}
