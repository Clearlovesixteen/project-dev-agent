import { AppError } from "../domain/error.js";
import { MergeRecoverySchema, type MergeRecovery } from "../domain/merge-recovery.js";
import { RelativePathSchema } from "../domain/common.js";
import type { WorktreeBinding } from "./baseline.js";
import { bindWorktree } from "./baseline.js";
import { readGit, decodeGitOutput, gitLine } from "./command.js";
import { ProjectFiles } from "../storage/project-files.js";
import { workspaceContent } from "./workspace-content.js";

/** 读取实际 index stages；只支持普通文件，链接和子模块不能借恢复权限越界。 */
export async function unmergedEntries(binding: WorktreeBinding) {
  const raw = decodeGitOutput((await readGit(binding.root, ["ls-files", "--unmerged", "-z"])).stdout);
  const entries = new Map<string, string[]>();
  for (const row of raw.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]+)$/.exec(row);
    if (!match || !RelativePathSchema.safeParse(match[4]).success)
      throw new AppError("MERGE_RECOVERY_UNSUPPORTED", "冲突恢复只支持仓库内普通文件；链接、子模块或异常路径需要单独处理");
    const path = match[4]!;
    if (path === ".project-dev" || path.startsWith(".project-dev/") || path === ".git" || path.startsWith(".git/"))
      throw new AppError("MERGE_RECOVERY_UNSUPPORTED", "不能将插件状态或 Git 元数据作为冲突恢复目标");
    entries.set(path, [...entries.get(path) ?? [], `${match[1]} ${match[2]} ${match[3]}`]);
  }
  return [...entries].map(([path, stages]) => ({ path, stages })).sort((a, b) => a.path.localeCompare(b.path));
}

async function mergeHead(binding: WorktreeBinding) {
  const result = await readGit(binding.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], [1]);
  return result.exitCode === 0 ? gitLine(result.stdout) : undefined;
}

/** 对来源只做提交解析，不选择 ours/theirs，不读取可执行 Git alias。 */
export async function resolveRecoverySource(binding: WorktreeBinding, reference: string) {
  if (!reference.trim() || reference.startsWith("-") || /[\0\r\n]/.test(reference))
    throw new AppError("MERGE_RECOVERY_SOURCE_INVALID", "冲突来源必须是用户明确指定的 Git 引用或提交");
  try { return gitLine((await readGit(binding.root, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`])).stdout); }
  catch { throw new AppError("MERGE_RECOVERY_SOURCE_INVALID", "指定冲突来源不存在或不是提交；请核对实际本地/远端引用，不自动改用其他来源"); }
}

export async function captureMergeRecovery(binding: WorktreeBinding, source?: string): Promise<MergeRecovery> {
  const merge_head = await mergeHead(binding), conflicts = await unmergedEntries(binding);
  if (!merge_head || !conflicts.length)
    throw new AppError("MERGE_RECOVERY_NOT_REQUIRED", "当前没有 Git merge 的未合并文件；普通开发使用常规任务，rebase/cherry-pick 不套用 merge 恢复权限");
  const recovery = MergeRecoverySchema.parse({ version: 1, head: binding.head, merge_head, conflicts,
    ...(source ? { source: { reference: source, commit: await resolveRecoverySource(binding, source) } } : {}) });
  await assertMergeRecovery(binding, recovery);
  return recovery;
}

/** 仅同一合并的冲突子集可继续。合并提交后可审查，但绝不把新merge或abort当成原恢复过程。 */
export async function assertMergeRecovery(binding: WorktreeBinding, recovery: MergeRecovery) {
  const current = await bindWorktree(binding.root), merge_head = await mergeHead(binding), conflicts = await unmergedEntries(binding);
  if (current.repo_identity !== binding.repo_identity || current.branch !== binding.branch)
    throw new AppError("MERGE_RECOVERY_CHANGED", "冲突恢复的仓库或分支已变化，请保留任务并重新核对");
  let completed = false;
  if (merge_head !== recovery.merge_head || current.head !== recovery.head) {
    const parents = gitLine((await readGit(binding.root, ["show", "-s", "--format=%P", current.head])).stdout).split(" ");
    completed = !merge_head && !conflicts.length && parents.length === 2 && parents[0] === recovery.head && parents[1] === recovery.merge_head;
    if (!completed) throw new AppError("MERGE_RECOVERY_CHANGED", "当前 HEAD、合并来源或状态与恢复任务不符；不能沿用旧冲突授权");
  }
  for (const conflict of conflicts) {
    const original = recovery.conflicts.find(item => item.path === conflict.path);
    if (!original || JSON.stringify(original.stages) !== JSON.stringify(conflict.stages))
      throw new AppError("MERGE_RECOVERY_CHANGED", "新增冲突或原冲突 stages 变化，请重新核对合并范围，不能自动扩大任务");
  }
  return { conflicts, completed, head: current.head, merge_head: merge_head ?? null };
}

/** 解决标记不等于解决业务；此处只补足Git冲突及指定来源的机械检查，仍须原验收与验证。 */
export async function assertMergeResolved(binding: WorktreeBinding, recovery: MergeRecovery) {
  const state = await assertMergeRecovery(binding, recovery);
  if (state.conflicts.length) throw new AppError("UNMERGED_CHANGES", "恢复任务已就绪；先修复并暂存原冲突文件，再执行审查和验证");
  const files = new ProjectFiles(binding.root);
  for (const { path } of recovery.conflicts) {
    const item = await workspaceContent(files, path, true);
    if (item.entry.kind === "symlink") throw new AppError("MERGE_RECOVERY_UNSUPPORTED", "冲突文件不能替换为符号链接");
    // unmerged清空只说明index已选定版本；其后修改的工作副本也必须重新暂存，避免提交旧冲突内容。
    if ((await readGit(binding.root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", "--", `:(literal)${path}`], [1])).exitCode !== 0)
      throw new AppError("MERGE_RECOVERY_NOT_STAGED", `修复后的内容尚未完整暂存：${path}；仅对原冲突文件执行 git add -- 后重新检查`);
    if (item.content && /^(?:<{7,}|\|{7,}|={7,}|>{7,})(?:\s|$)/m.test(item.content.toString("utf8")))
      throw new AppError("MERGE_MARKERS_REMAIN", `冲突文件仍包含合并标记：${path}`);
    if (recovery.source) {
      const metadata = gitLine((await readGit(binding.root, ["ls-tree", recovery.source.commit, "--", `:(literal)${path}`])).stdout);
      if (!metadata && item.entry.kind === "missing") continue;
      if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(metadata)) throw new AppError("MERGE_RECOVERY_SOURCE_MISMATCH", `指定来源不存在对应普通文件，结果必须与来源一致：${path}`);
      const index = decodeGitOutput((await readGit(binding.root, ["ls-files", "--stage", "-z", "--", `:(literal)${path}`])).stdout);
      const expected = /^(100(?:644|755)) blob ([a-f0-9]+)\t/.exec(metadata)!;
      if (index !== `${expected[1]} ${expected[2]} 0\t${path}\0`)
        throw new AppError("MERGE_RECOVERY_SOURCE_MISMATCH", `暂存结果与任务指定的来源提交不一致：${path}；需要改变策略时先显式结束当前恢复任务`);
    }
  }
}
