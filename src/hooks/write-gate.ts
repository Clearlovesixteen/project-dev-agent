import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorktreeBinding } from "../git/index.js";
import { assertBaseline, assertStateIgnored } from "../git/index.js";
import { TaskStore } from "../storage/task-store.js";
import { ParticipationStore } from "../workflow/participation.js";
import { Interaction, interactionOwner, type InteractionContext } from "../workflow/interaction.js";
import { implementationBasisReview } from "../quality/implementation-basis.js";
import { denyWrite, type NativeHookInput } from "./contracts.js";
import { patchPaths, projectTool, toolArguments, writeKind } from "./tool-policy.js";
import { ProjectFiles } from "../storage/project-files.js";

async function inputStaging(input: NativeHookInput, project: string) {
  if (writeKind(input) !== "patch") return false;
  const targets = patchPaths(input).map(path => relative(project, isAbsolute(path) ? path : resolve(input.cwd, path)).split(sep).join("/"));
  if (!targets.length || !targets.every(path => /^\.project-dev\/local\/inputs\/[a-zA-Z0-9_.-]+\.json$/.test(path))) return false;
  const files = new ProjectFiles(project);
  for (const path of targets) await files.path(path, true);
  return true;
}

/** 相同宿主轮次重试复用 operation_id，不能把另一个会话的任务自动据为己有。 */
function operationId(project: string, interaction: InteractionContext, requirement: unknown): string {
  const value = createHash("sha256").update(JSON.stringify([project, interaction.session_id, interaction.actor_id ?? "main", interaction.turn_id, requirement])).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

/** 只补本插件参数的会话关联；不替换 project、需求、修订号，也不改其他插件。 */
export function nativeToolIdentity(input: NativeHookInput, project: string, interaction: InteractionContext) {
  const tool = projectTool(input.tool_name), args = toolArguments(input);
  if (!tool || !args) return undefined;
  const existing = args.interaction === undefined ? undefined : Interaction.safeParse(args.interaction);
  if (existing && !existing.success) return denyWrite("Project Dev Agent：interaction 格式无效，请保留宿主提供的会话身份后重试。");
  const prior = existing?.success ? existing.data : undefined;
  if (prior && (prior.session_id !== interaction.session_id || (prior.actor_id ?? "main") !== (interaction.actor_id ?? "main")))
    return denyWrite("Project Dev Agent：本次调用的会话身份与宿主不符，不能接管其他聊天任务。请使用当前会话身份重试。");
  const next = { ...prior, ...interaction,
    ...(tool === "task_open" && interaction.turn_id && !prior?.operation_id ? { operation_id: operationId(project, interaction, args.requirement) } : {}) };
  if (JSON.stringify(prior) === JSON.stringify(next)) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...args, interaction: next } } };
}

/** 原生工具检查只读项目状态；不替用户运行脚本、修改代码、终止任务或扩大工作范围。 */
export async function checkProjectWrite(input: NativeHookInput, binding: WorktreeBinding, interaction: InteractionContext, home?: string): Promise<{ output: Record<string, unknown>; reason: string; ready: boolean; task?: string; coverage?: "observed" | "partial" }> {
  const kind = writeKind(input);
  if (!kind) return { output: {}, reason: "READ_ONLY_OR_UNSUPPORTED", ready: false };
  const stop = (reason: string, instruction: string) => ({ output: denyWrite(`Project Dev Agent：${instruction}\nproject=${binding.root}；使用宿主当前 interaction，不向用户追加表单。补齐后重试。若实际调用成功后仍连续出现相同原因，先 plugin_status 核对当前进程版本并重新加载插件，不能反复建任务或换工具绕过。`), reason, ready: false });
  try { await assertStateIgnored(binding); }
  catch { return stop("PROJECT_SETUP_REQUIRED", "当前项目未就绪。先调用 project_prepare(apply:true)，再 project_scan、project_context 和 task_open。"); }
  // 正式 CLI 的工具输入文件是受控中转，不是任务存储。仅允许 inputs/*.json，
  // 不放行对 tasks、模型、检查结果或任意业务路径的直接写入。
  if (await inputStaging(input, binding.root)) return { output: {}, reason: "PLUGIN_INPUT_STAGING", ready: true, coverage: "partial" };
  const store = new ParticipationStore(home), state = await store.read(binding.root, interaction, binding.branch);
  if (!state || state.branch !== binding.branch || !state.context_at || Date.now() - state.context_at > 30 * 60_000 || !state.context_ready)
    return stop("CONTEXT_QUERY_REQUIRED", "修改前须查询本项目 project_context 的 implementation_context，并读取相关规范和同类实现；没有结构索引时先 project_scan，然后建立或恢复 task_open/task_check。");
  const task = await new TaskStore(binding.root).active(binding.branch);
  if (!task) return stop("TASK_BINDING_REQUIRED", "本分支没有活跃任务。先 task_open 保存本次需求、验收和项目实现依据，再记录关联修改清单。");
  const owner = interactionOwner(interaction);
  if (task.owner && (task.owner.session_id !== owner.session_id || task.owner.actor_id !== owner.actor_id))
    return stop("TASK_SESSION_MISMATCH", "本分支任务属于另一聊天。保留原任务；使用独立工作树，或由原会话显式挂起任务后再开始，不能自动中止或接管。");
  if (state.task_id !== task.id) return stop("TASK_BINDING_REQUIRED", "本会话尚未核对当前任务。相关任务用 task_check 恢复；新需求不得直接沿用不相关任务。");
  if (!interaction.turn_id || state.last_turn !== interaction.turn_id)
    return stop("TASK_TURN_REVIEW_REQUIRED", "本轮尚未核对任务。继续同一需求先 task_check；范围变化重新查询 project_context 并更新影响清单，独立需求另建任务。");
  try { await assertBaseline(binding, task); }
  catch { return stop("TASK_BASELINE_REVIEW_REQUIRED", "当前任务基线不适用。调用 task_check 查看恢复信息，切回原分支继续，或显式挂起旧任务后建立本分支任务。"); }
  const basis = task.implementation_bases?.at(-1);
  if (!basis) return stop("IMPLEMENTATION_BASIS_REQUIRED", "先读取现有能力，使用 task_update.implementation_basis 保存复用、模块化和本次实现选择及原文依据；不要另起已有封装。");
  const review = await implementationBasisReview(binding, task, basis.review_snapshot);
  if (review.references.some(reference => reference.state === "stale"))
    return stop("IMPLEMENTATION_REFERENCE_STALE", "实现依据来源已失效。重新读取当前源码并追加 implementation_basis，保留原记录。");
  const planned = task.change_items.filter(item => item.action === "modify").map(item => item.target_path);
  if (!planned.length) return stop("WRITE_SCOPE_REQUIRED", "先用 task_update.change_items 记录本次修改位置、原因和相关验收，保留已有 ID。");
  if (kind === "patch") {
    const paths = patchPaths(input);
    if (!paths.length) return stop("WRITE_TARGET_UNKNOWN", "无法识别补丁目标。使用标准 apply_patch 文件头，先记录目标位置后重试。");
    for (const path of paths) {
      const target = relative(binding.root, isAbsolute(path) ? path : resolve(input.cwd, path)).split(sep).join("/");
      if (target === ".." || target.startsWith("../") || isAbsolute(target))
        return stop("WRITE_PROJECT_MISMATCH", "补丁包含当前项目之外的位置。拆分修改并核对对应项目范围，不能自动扩大配置。");
      if (!planned.includes(target)) return stop("WRITE_SCOPE_REQUIRED", `补丁目标 ${target} 尚未记录在本任务修改清单。核对关联范围后追加清单，再重试。`);
    }
  }
  await store.change(binding.root, interaction, binding.branch, next => {
    next.guard_seen = true;
    if (input.tool_use_id && !next.pending_tools.includes(input.tool_use_id)) next.pending_tools.push(input.tool_use_id);
  });
  return { output: {}, reason: "WRITE_READY", ready: true, task: task.id, coverage: kind === "patch" ? "observed" as const : "partial" as const };
}

/** PostToolUse 只证明支持的工具返回了结果，既不等同于产生 Git 差异，也不等同于验收通过。 */
export async function observeWriteResult(input: NativeHookInput, binding: WorktreeBinding, interaction: InteractionContext, home?: string) {
  if (!writeKind(input) || !input.tool_use_id) return false;
  if (await inputStaging(input, binding.root)) return undefined;
  const store = new ParticipationStore(home), state = await store.read(binding.root, interaction, binding.branch);
  if (!state || state.branch !== binding.branch) return false;
  if (state.completed_tools.includes(input.tool_use_id)) return true;
  if (!state.pending_tools.includes(input.tool_use_id)) return false;
  await store.change(binding.root, interaction, binding.branch, next => {
    if (next.completed_tools.includes(input.tool_use_id!)) return;
    next.pending_tools = next.pending_tools.filter(id => id !== input.tool_use_id);
    next.completed_tools = [...next.completed_tools, input.tool_use_id!].slice(-40); next.write_calls++;
  });
  return true;
}
