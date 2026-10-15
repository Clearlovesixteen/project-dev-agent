import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "./domain/error.js";
import { bindWorktree, type WorktreeBinding } from "./git/index.js";

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** Each request names its project; no process-wide current-project state. */
export class Workspace {
  private constructor(readonly root: string, private readonly requestedRoot: string) {}

  static async open(path: string): Promise<Workspace> {
    if (!isAbsolute(path)) throw new AppError("WORKSPACE_PATH_INVALID", "工作目录必须使用绝对路径");
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new AppError("WORKSPACE_PATH_INVALID", "工作范围必须是目录");
    return new Workspace(root, resolve(path));
  }

  async bind(project?: string): Promise<WorktreeBinding> {
    if (!project || !isAbsolute(project)) throw new AppError("PROJECT_REQUIRED", "每次调用都需传入 project，值为当前 Git 工作树的绝对根目录");
    if (await realpath(this.requestedRoot) !== this.root || await realpath(this.root) !== this.root || !(await lstat(this.root)).isDirectory()) {
      throw new AppError("WORKSPACE_CHANGED", "已配置的工作目录标识发生变化");
    }
    const supplied = resolve(project);
    // Accept the same root spelling used at configuration time (e.g. macOS /var -> /private/var).
    const requested = within(this.root, supplied) ? supplied
      : within(this.requestedRoot, supplied) ? join(this.root, relative(this.requestedRoot, supplied)) : undefined;
    if (!requested) throw new AppError("PROJECT_OUTSIDE_WORKSPACE", "当前项目不在已配置的工作范围内");
    let current = this.root;
    for (const segment of relative(this.root, requested).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new AppError("PROJECT_PATH_UNSAFE", "不支持通过符号链接访问项目路径");
    }
    const binding = await bindWorktree(requested);
    if (!within(this.root, binding.root) || !within(this.root, binding.repo_identity)) {
      throw new AppError("PROJECT_OUTSIDE_WORKSPACE", "工作树及其 Git 公共目录都必须位于已配置的工作范围内");
    }
    return binding;
  }
}
