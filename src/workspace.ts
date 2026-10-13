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
    if (!isAbsolute(path)) throw new AppError("WORKSPACE_PATH_INVALID", "Workspace path must be absolute");
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new AppError("WORKSPACE_PATH_INVALID", "Workspace must be a directory");
    return new Workspace(root, resolve(path));
  }

  async bind(project?: string): Promise<WorktreeBinding> {
    if (!project || !isAbsolute(project)) throw new AppError("PROJECT_REQUIRED", "Pass project as the absolute current Git worktree root on every call");
    if (await realpath(this.requestedRoot) !== this.root || await realpath(this.root) !== this.root || !(await lstat(this.root)).isDirectory()) {
      throw new AppError("WORKSPACE_CHANGED", "The configured workspace changed identity");
    }
    const supplied = resolve(project);
    // Accept the same root spelling used at configuration time (e.g. macOS /var -> /private/var).
    const requested = within(this.root, supplied) ? supplied
      : within(this.requestedRoot, supplied) ? join(this.root, relative(this.requestedRoot, supplied)) : undefined;
    if (!requested) throw new AppError("PROJECT_OUTSIDE_WORKSPACE", "Project is outside the configured workspace");
    let current = this.root;
    for (const segment of relative(this.root, requested).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new AppError("PROJECT_PATH_UNSAFE", "Symbolic project paths are not supported");
    }
    const binding = await bindWorktree(requested);
    if (!within(this.root, binding.root) || !within(this.root, binding.repo_identity)) {
      throw new AppError("PROJECT_OUTSIDE_WORKSPACE", "The worktree and its Git common directory must be inside the configured workspace");
    }
    return binding;
  }
}
