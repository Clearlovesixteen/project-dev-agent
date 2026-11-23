import { createHash } from "node:crypto";
import type { WorktreeBinding } from "../git/index.js";
import { assertBaseline, assertStateIgnored } from "../git/index.js";
import { TaskStore } from "../storage/task-store.js";
import { ParticipationStore } from "../workflow/participation.js";
import { Interaction, interactionOwner, type InteractionContext } from "../workflow/interaction.js";
import { checkWriteReferences } from "../quality/implementation-basis.js";
import { denyWrite, type NativeHookInput } from "./contracts.js";
import { projectTool, toolArguments, toolCommandDecision, writeKind } from "./tool-policy.js";
import { mergeRecoveryWrite } from "./merge-recovery-gate.js";
import type { DiagnosticContext } from "../observability/diagnostic-context.js";
import { diagnosticAction, diagnosticCause } from "./diagnostic-context.js";
import { modificationScope } from "../quality/business-plan.js";
import { domainGuidance } from "../tools/task-guidance.js";
import { guidanceEnabled } from "../runtime/guidance-release.js";

function inputStaging(input: NativeHookInput, targets: readonly string[]) {
  return input.tool_name === "apply_patch" && targets.length > 0
    && targets.every(path => /^\.project-dev\/local\/inputs\/[a-zA-Z0-9_.-]+\.json$/.test(path));
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
export async function checkProjectWrite(input: NativeHookInput, binding: WorktreeBinding, interaction: InteractionContext, home: string,
  pluginRoot: string, diagnostic: DiagnosticContext, targets: readonly string[] = [], targetResolution: "known" | "unknown" | "not_applicable" = "not_applicable"): Promise<{ output: Record<string, unknown>; reason: string; ready: boolean; task?: string; coverage?: "observed" | "partial" }> {
  const kind = writeKind(input, pluginRoot);
  if (!kind) return { output: {}, reason: "READ_ONLY_OR_UNSUPPORTED", ready: false };
  const uncertain = toolCommandDecision(input)?.classification === "unknown"
    ? "当前复杂命令尚不能可靠确认是否只读。仅需阅读时，保持原意拆分为可判定的读取步骤；实际修改仍须完成准备。" : "";
  let observedTask: string | undefined;
  const stop = (reason: string, instruction: string) => {
    diagnostic.decision = "deny"; diagnostic.required_action = reason === "TASK_BINDING_REQUIRED" && diagnostic.task_state === "not_bound" ? "check_task" : diagnosticAction(reason);
    return { output: denyWrite(`Project Dev Agent：${uncertain}${instruction}\nproject=${binding.root}；使用宿主当前 interaction 补齐对应步骤后重试。`), reason, ready: false, ...(observedTask ? { task: observedTask } : {}) };
  };
  diagnostic.stage = "state";
  try { await assertStateIgnored(binding); }
  catch { return stop("PROJECT_SETUP_REQUIRED", guidanceEnabled()
    ? "当前项目未就绪。先用本工作树调用 project_prepare(apply:true)，按准备结果继续。"
    : "当前项目未就绪。先调用 project_prepare(apply:true)，再 project_scan、project_context 和 task_open。"); }
  // 正式 CLI 的工具输入文件是受控中转，不是任务存储。仅允许 inputs/*.json，
  // 不放行对 tasks、模型、检查结果或任意业务路径的直接写入。
  if (inputStaging(input, targets)) { diagnostic.decision = "allow"; diagnostic.required_action = "none"; return { output: {}, reason: "PLUGIN_INPUT_STAGING", ready: true, coverage: "partial" }; }
  diagnostic.stage = "context";
  const store = new ParticipationStore(home), state = await store.read(binding.root, interaction, binding.branch);
  diagnostic.context_state = !state || !state.context_at ? "missing" : Date.now() - state.context_at > 30 * 60_000 ? "expired" : !state.context_ready || state.branch !== binding.branch ? "not_ready" : "ready";
  const tasks = new TaskStore(binding.root);
  diagnostic.stage = "task";
  // 先识别已确认的归属冲突。缺上下文时只做有界查找，不能拖住恢复提示或放行写入。
  const task = diagnostic.context_state === "ready" ? await tasks.active(binding.branch)
    : await tasks.active(binding.branch, AbortSignal.timeout(250)).catch(() => null);
  if (task) {
    observedTask = task.id; diagnostic.task_phase = task.phase;
    diagnostic.task_kind = task.workspace_baseline?.merge_recovery ? "merge_recovery" : "development";
    diagnostic.stage = "owner";
    const owner = interactionOwner(interaction);
    const otherOwner = task.owner && (task.owner.session_id !== owner.session_id || task.owner.actor_id !== owner.actor_id);
    diagnostic.task_state = !task.owner ? "unowned" : otherOwner ? "other_owner" : "owned";
    if (otherOwner) return stop("TASK_SESSION_MISMATCH", "本分支任务属于另一聊天。保留原任务；使用独立工作树，或由原会话显式挂起任务后再开始，不能自动中止或接管。");
  } else if (task === undefined) diagnostic.task_state = "missing";
  if (!state || diagnostic.context_state !== "ready") {
    diagnostic.stage = "context";
    const explanation = { missing: "当前工作树尚无实现依据查询。", expired: "当前工作树的实现依据查询已过期。",
      not_ready: "当前工作树的实现依据查询尚未返回可用的项目结构。" }[diagnostic.context_state as "missing" | "expired" | "not_ready"];
    return stop("CONTEXT_QUERY_REQUIRED", `${explanation ?? ""}修改前请用本工作树调用 project_context 并阅读 implementation_context；索引缺失或过期时先运行 project_scan。`);
  }
  if (!task) return stop("TASK_BINDING_REQUIRED", "本分支没有活跃任务。先 task_open 保存本次需求、验收和项目实现依据，再记录关联修改清单。");
  if (state.task_id !== task.id) { diagnostic.task_state = "not_bound"; return stop("TASK_BINDING_REQUIRED", "本会话尚未核对当前任务。相关任务用 task_check(mode:\"resume\") 恢复；新需求不得直接沿用不相关任务。"); }
  diagnostic.stage = "turn";
  if (!interaction.turn_id || state.last_turn !== interaction.turn_id) {
    diagnostic.task_state = "not_confirmed_this_turn";
    return stop("TASK_TURN_REVIEW_REQUIRED", "本轮尚未核对任务。继续同一需求先 task_check(mode:\"resume\")；范围变化重新查询 project_context 并更新影响清单，独立需求另建任务。");
  }
  diagnostic.stage = "baseline";
  try { await assertBaseline(binding, task); diagnostic.baseline_state = "valid"; }
  catch (error) { diagnostic.baseline_state = "invalid"; diagnostic.cause_code = diagnosticCause(error); return stop("TASK_BASELINE_REVIEW_REQUIRED", "当前任务基线不适用。调用 task_check 查看恢复信息，切回原分支继续，或显式挂起旧任务后建立本分支任务。"); }
  diagnostic.stage = "basis";
  const basis = task.implementation_bases?.at(-1);
  if (!basis) diagnostic.basis_state = "missing";
  if (!basis) return stop("IMPLEMENTATION_BASIS_REQUIRED", "先读取现有能力，使用 task_update.implementation_basis 保存复用、模块化和本次实现选择及原文依据；不要另起已有封装。");
  const references = await checkWriteReferences(binding, task, state.basis_receipt);
  diagnostic.basis_state = references.valid ? "ready" : "stale";
  if (!references.valid) {
    if (!guidanceEnabled()) return stop("IMPLEMENTATION_REFERENCE_STALE", "实现依据来源已失效。重新读取当前源码并追加 implementation_basis，保留原记录。");
    const guidance = domainGuidance("task_update", "IMPLEMENTATION_REFERENCE_STALE", "", {});
    return stop("IMPLEMENTATION_REFERENCE_STALE", `实现依据来源已失效。待复核引用：${references.stale_ids?.join("、") ?? "当前依据"}。${guidance.instruction} 使用 task_update 追加 implementation_basis。`);
  }
  const recoveryGate = await mergeRecoveryWrite(input, binding, task, pluginRoot, diagnostic, targets);
  if (recoveryGate) return stop(recoveryGate.reason, recoveryGate.instruction);
  const plan = task.business_plans?.at(-1);
  if (task.business_model_policy && !plan && !task.workspace_baseline?.merge_recovery)
    return stop("BUSINESS_PLAN_REQUIRED", "当前任务启用了业务计划。先用 task_update 保存规则、实际代码位置和场景验收，再修改业务代码。");
  const modelScope = plan ? modificationScope(plan) : undefined;
  const planned = task.change_items.filter(item => item.action === "modify").map(item => item.target_path);
  diagnostic.stage = "target"; diagnostic.planned_count = Math.min(planned.length, 500);
  if (!planned.length) diagnostic.target_scope = "unplanned";
  if (!planned.length) return stop("WRITE_SCOPE_REQUIRED", "先用 task_update.change_items 记录本次修改位置、原因和相关验收，保留已有 ID。");
  // 合并恢复任务中的 validation run 已由 mergeRecoveryWrite 按任务、项目和检查 ID
  // 精确核验，不能再次被普通 shell 未知目标规则拦截。其他动态 shell 写入仍然拒绝。
  if (targetResolution === "unknown" && !task.workspace_baseline?.merge_recovery)
    return stop("WRITE_TARGET_UNKNOWN", "无法可靠识别 shell 写入目标。请拆成明确的单文件修改命令，或使用 apply_patch 并提供标准文件头。不能按未知目标放行。");
  if (kind === "patch" || targetResolution === "known") {
    const resolvedTargets = targets ?? [];
    diagnostic.target_count = Math.min(resolvedTargets.length, 500); diagnostic.target_scope = "unknown";
    if (!resolvedTargets.length && kind === "patch") return stop("WRITE_TARGET_UNKNOWN", "无法识别补丁目标。请使用标准 apply_patch 文件头或明确的 file_path。");
    for (const target of resolvedTargets) {
      if (!planned.includes(target)) { diagnostic.target_scope = "unplanned"; return stop("WRITE_SCOPE_REQUIRED", `补丁目标 ${target} 尚未记录在本任务修改清单。核对关联范围后追加清单，再重试。`); }
      if (modelScope && !modelScope.has(target)) {
        diagnostic.target_scope = "unplanned";
        return stop("BUSINESS_PLAN_SCOPE_REQUIRED", `补丁目标 ${target} 未获本任务的业务计划允许。先查明与需求的关系，再补充修改依据。`);
      }
    }
    diagnostic.target_scope = "within";
  }
  await store.change(binding.root, interaction, binding.branch, next => {
    next.guard_seen = true; next.basis_receipt = references.receipt;
    if (input.tool_use_id && !next.pending_tools.includes(input.tool_use_id)) next.pending_tools.push(input.tool_use_id);
  });
  diagnostic.stage = "ready"; diagnostic.decision = "allow"; diagnostic.required_action = "none";
  return { output: {}, reason: "WRITE_READY", ready: true, task: task.id, coverage: targetResolution === "known" ? "observed" as const : "partial" as const };
}

/** PostToolUse 只证明支持的工具返回了结果，既不等同于产生 Git 差异，也不等同于验收通过。 */
export async function observeWriteResult(input: NativeHookInput, binding: WorktreeBinding, interaction: InteractionContext, home?: string, targets: readonly string[] = []) {
  if (!writeKind(input) || !input.tool_use_id) return false;
  if (inputStaging(input, targets)) return undefined;
  const store = new ParticipationStore(home), state = await store.read(binding.root, interaction, binding.branch);
  if (!state || state.branch !== binding.branch) return false;
  if (state.completed_tools.includes(input.tool_use_id)) return true;
  if (!state.pending_tools.includes(input.tool_use_id)) return false;
  if (toolResponseFailed(input.tool_response)) return "failed" as const;
  await store.change(binding.root, interaction, binding.branch, next => {
    if (next.completed_tools.includes(input.tool_use_id!)) return;
    next.pending_tools = next.pending_tools.filter(id => id !== input.tool_use_id);
    next.completed_tools = [...next.completed_tools, input.tool_use_id!].slice(-40); next.write_calls++;
  });
  return true;
}

/** 宿主返回结构可能随工具变化，只有明确失败才保留 pending，未知结构按兼容路径处理。 */
function toolResponseFailed(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (response.is_error === true || response.isError === true || response.success === false) return true;
  if (typeof response.status === "string" && /^(?:error|failed|failure|cancelled|canceled)$/i.test(response.status)) return true;
  return response.error !== undefined && response.error !== null;
}
