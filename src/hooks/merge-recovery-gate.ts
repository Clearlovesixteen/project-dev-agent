import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/index.js";
import { assertMergeRecovery, assertMergeResolved, resolveRecoverySource } from "../git/merge-recovery.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { ProjectFiles } from "../storage/project-files.js";
import type { NativeHookInput } from "./contracts.js";
import { patchPaths, toolArguments, toolWorkingDirectory, writeKind } from "./tool-policy.js";
import { singleCommand, shellDialect } from "./shell-policy.js";
import type { DiagnosticContext } from "../observability/diagnostic-context.js";
import { diagnosticAction } from "./diagnostic-context.js";

/** 仅使用宿主传入的当前插件路径，逐项绑定项目、任务和已保存检查；不接受任意node脚本。 */
function savedValidation(words: string[] | undefined, input: NativeHookInput, binding: WorktreeBinding, task: Task, pluginRoot?: string) {
  if (!pluginRoot || !words || words.length !== 10 || !["node", process.execPath].includes(words[0] ?? "") || !words[1]
    || ![resolve(pluginRoot, "runtime/cli.mjs"), resolve(pluginRoot, "dist/src/cli.js")].includes(words[1])
    || words[2] !== "validation" || words[3] !== "run") return false;
  const options = new Map<string, string>();
  for (let index = 4; index < words.length; index += 2) {
    if (!["--project", "--task-id", "--check-id"].includes(words[index]!) || options.has(words[index]!)) return false;
    options.set(words[index]!, words[index + 1]!);
  }
  return options.get("--project") === binding.root && options.get("--task-id") === task.id
    && !!task.validation_plans?.at(-1)?.plan.checks.some(check => check.id === options.get("--check-id"));
}

/** 恢复任务不获得普通终端写权限，只识别精确文件补丁及不含组合语法的restore/add。 */
export async function mergeRecoveryWrite(input: NativeHookInput, binding: WorktreeBinding, task: Task, pluginRoot?: string, diagnostic: DiagnosticContext = { version: 1 }): Promise<{ reason: string; instruction: string } | undefined> {
  const recovery = task.workspace_baseline?.merge_recovery;
  if (!recovery) return;
  diagnostic.stage = "merge"; diagnostic.initial_conflict_count = Math.min(recovery.conflicts.length, 500); diagnostic.recovery_source = recovery.source ? "selected" : "not_selected";
  const stop = (reason: string, instruction: string) => { diagnostic.decision = "deny"; diagnostic.required_action = diagnosticAction(reason); return { reason, instruction }; };
  let state;
  try { state = await assertMergeRecovery(binding, recovery); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "MERGE_RECOVERY_CHANGED") diagnostic.merge_state = "changed";
    throw error;
  }
  diagnostic.merge_state = state.completed ? "committed" : state.conflicts.length ? "unmerged" : "resolved_uncommitted";
  diagnostic.conflict_count = Math.min(state.conflicts.length, 500);
  const snapshot = await reviewSnapshot(binding, task.baseline_head, task.workspace_baseline, { allow_unmerged: true });
  const allowed = new Set(recovery.conflicts.map(item => item.path));
  if (snapshot.paths.some(path => !allowed.has(path))) { diagnostic.target_scope = "outside"; return stop("MERGE_RECOVERY_SCOPE", "检测到恢复范围外的新改动；先核对来源，不将其归入当前冲突任务。"); }
  let targets: string[] = [];
  const args = toolArguments(input);
  if (writeKind(input) === "patch") {
    targets = patchPaths(input);
    // 宿主的结构化Edit/Write也必须给出一个明确路径；不从自由文本猜测。
    if (!targets.length && ["Edit", "Write"].includes(input.tool_name ?? "") && typeof args?.file_path === "string") targets = [args.file_path];
  } else {
    const words = singleCommand(args?.command ?? args?.cmd, shellDialect(input.cwd, args?.shell));
    if (savedValidation(words, input, binding, task, pluginRoot)) { diagnostic.stage = "validation"; diagnostic.command_family = "validation"; await assertMergeResolved(binding, recovery); return; }
    if (!words || !["git", "git.exe"].includes(words[0] ?? ""))
      return stop("MERGE_RECOVERY_COMMAND_REQUIRED", "恢复任务仅允许精确冲突路径的补丁，或单条 git restore / git add；不允许脚本、复合命令或任意终端写入。");
    const separator = words.indexOf("--");
    if (separator < 2 || separator === words.length - 1) return stop("MERGE_RECOVERY_COMMAND_REQUIRED", "Git恢复命令必须用 -- 分隔并列出原冲突文件，不能使用目录、通配符或隐式全部文件。");
    targets = words.slice(separator + 1);
    diagnostic.target_count = Math.min(targets.length, 500);
    if (words[1] === "add") {
      if (separator !== 2) return stop("MERGE_RECOVERY_COMMAND_REQUIRED", "恢复任务的暂存命令仅支持 git add -- <原冲突文件>，不支持 -A 等扩大范围的参数。");
    } else if (words[1] === "restore") {
      const flags = words.slice(2, separator), sources = flags.filter(value => value.startsWith("--source="));
      if (sources.length !== 1 || flags.length !== 3 || !flags.includes("--staged") || !flags.includes("--worktree") || !recovery.source)
        return stop("MERGE_RECOVERY_SOURCE_REQUIRED", "restore须同时指定 --staged --worktree 及任务中用户明确指定的 --source；未指定来源时先阅读双方，用补丁合并，不能自动选择ours/theirs。");
      const reference = sources[0]!.slice("--source=".length);
      if (![recovery.source.reference, recovery.source.commit].includes(reference) || await resolveRecoverySource(binding, reference) !== recovery.source.commit) {
        diagnostic.recovery_source = "mismatch";
        return stop("MERGE_RECOVERY_SOURCE_MISMATCH", "restore来源与任务固定的用户指定提交不符，或该引用已移动；核对后使用任务保存的完整提交ID。");
      }
      diagnostic.recovery_source = "matched";
    } else return stop("MERGE_RECOVERY_COMMAND_REQUIRED", "恢复任务只允许精确路径的restore/add；提交、reset、checkout、merge和其他写命令不在恢复写权限内。");
  }
  if (state.completed) return stop("MERGE_RECOVERY_FINISHED", "该合并已提交；恢复任务只供验证、审查和关闭，继续业务修改另建任务。");
  diagnostic.stage = "target"; diagnostic.target_count = Math.min(targets.length, 500); diagnostic.target_scope = "unknown";
  if (!targets.length) return stop("WRITE_TARGET_UNKNOWN", "无法确定冲突修复目标；请使用明确路径的标准补丁或结构化Edit/Write。");
  const files = new ProjectFiles(binding.root);
  for (const path of targets) {
    if (path.split(/[\\/]/).includes("..")) return stop("MERGE_RECOVERY_SCOPE", "冲突修复路径不能包含父目录跳转；使用任务记录的精确路径。");
    // Shell展开和Git pathspec都不是字面文件名；特殊名称需用结构化补丁处理。
    if (writeKind(input) === "shell" && /[*?\[\]~:]|^\-/.test(path)) return stop("MERGE_RECOVERY_SCOPE", "恢复命令只接受字面文件路径，不接受pathspec、通配符或选项样式路径。");
    const target = relative(binding.root, isAbsolute(path) ? path : resolve(toolWorkingDirectory(input), path)).split(sep).join("/");
    if (!allowed.has(target)) { diagnostic.target_scope = "outside"; return stop("MERGE_RECOVERY_SCOPE", "只能修改任务捕获的原冲突文件，不能修改无关文件、目录或仓库外路径。"); }
    // 拒绝由外部并发替换的链接目录/文件，即使文本路径仍在允许集合中。
    await files.path(target, true);
  }
  diagnostic.target_scope = "within";
}
