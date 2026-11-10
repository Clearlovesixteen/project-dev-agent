import { z } from "zod";
import { randomUUID } from "node:crypto";
import { RuntimeSettings, runtimeFiles } from "../runtime/config.js";
import { DiagnosticWriter } from "../observability/writer.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode } from "../storage/project-files.js";
import { interactionOwner, type InteractionContext } from "./interaction.js";
import { setTimeout as delay } from "node:timers/promises";
import { bindWorktree } from "../git/index.js";

const ROOT = "project-dev-agent/participation";
const State = z.object({
  schema_version: z.literal(1), generation: z.uuid(), updated_at: z.number(),
  branch: z.string().nullable(), guard_seen: z.boolean(),
  context_id: z.string().regex(/^[a-f0-9]{64}$/).nullable(), context_at: z.number().nullable(),
  context_ready: z.boolean(), context_turn: z.string().nullable(), task_id: z.string().nullable(), phase: z.string().nullable(),
  write_calls: z.number().int().nonnegative(), checked_calls: z.number().int().nonnegative(),
  check_outcome: z.enum(["ok", "incomplete"]).nullable(),
  pending_tools: z.array(z.string().max(300)).max(40), completed_tools: z.array(z.string().max(300)).max(40), last_turn: z.string().nullable(),
}).strict();
type ParticipationState = z.infer<typeof State>;

/**
 * 本地运行状态与诊断开关分开：关闭上报仍保留修改前检查。
 * 路径使用项目/会话/执行者的 HMAC；不保存需求、源码、命令或真实路径。
 * 记录证明工具调用经过流程，不能证明模型理解或代码业务正确。
 */
export class ParticipationStore {
  private readonly home: string;
  constructor(home?: string) { this.home = new RuntimeSettings(home).home; }
  private async path(project: string, interaction: InteractionContext, branch: string | null) {
    const id = await new DiagnosticWriter(this.home).opaque(JSON.stringify([project, branch, interaction.session_id, interaction.actor_id ?? "main"]));
    return `${ROOT}/${id}.json`;
  }
  private fresh(branch: string | null): ParticipationState {
    return { schema_version: 1, generation: randomUUID(), updated_at: Date.now(), branch, guard_seen: false,
      context_id: null, context_at: null, context_ready: false, context_turn: null, task_id: null, phase: null,
      write_calls: 0, checked_calls: 0, check_outcome: null, pending_tools: [], completed_tools: [], last_turn: null };
  }
  async read(project: string, interaction: InteractionContext, branch: string | null): Promise<ParticipationState | undefined> {
    const files = await runtimeFiles(this.home);
    try { return State.parse(JSON.parse(await files.read(await this.path(project, interaction, branch)))); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }
  async change(project: string, interaction: InteractionContext, branch: string | null, mutate: (state: ParticipationState) => void) {
    const files = await runtimeFiles(this.home), path = await this.path(project, interaction, branch);
    await files.directory(ROOT);
    // 并行工具可能同时回写。短期限重试本模块锁；不能无限等待拖住宿主。
    const locked = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await acquireFileLock(files, `${path}.lock`, "PARTICIPATION_BUSY"); }
        catch (error) { if (!hasCode(error, "PARTICIPATION_BUSY") || attempt >= 20) throw error; await delay(10); }
      }
    };
    const release = await locked();
    try {
      let raw: string | undefined;
      try { raw = await files.read(path); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      const saved = raw ? State.parse(JSON.parse(raw)) : undefined;
      const next = !saved || saved.branch !== branch || Date.now() - saved.updated_at > 24 * 60 * 60_000 ? this.fresh(branch) : saved;
      mutate(next); next.updated_at = Date.now(); next.last_turn = interaction.turn_id ?? null;
      const content = JSON.stringify(State.parse(next));
      if (raw === undefined) await files.create(path, content); else await files.replace(path, content, raw);
      return next;
    } finally { await release(); }
  }

  /** 只接受成功/部分成功的本插件真实返回，不接受调用方自报“已经使用插件”。 */
  async observedTool(project: string, interaction: InteractionContext, branch: string | null, tool: string,
    value: { outcome?: string; data?: Record<string, unknown> }) {
    if (!value.data || value.outcome === "error" || !["project_context", "task_open", "task_update", "task_check"].includes(tool)) return;
    const data = value.data;
    // 历史查询与跨会话只读查看不属于当前任务接续，不能覆盖当前任务或清零待检查记录。
    if ((tool === "task_check" || tool === "task_open") && data.phase !== "active") return;
    const savedTask = (tool === "task_check" ? data.recorded_task : data) as { owner?: { session_id: string; actor_id: string } } | undefined;
    const owner = interactionOwner(interaction);
    if (savedTask?.owner && (savedTask.owner.session_id !== owner.session_id || savedTask.owner.actor_id !== owner.actor_id)) return;
    await this.change(project, interaction, branch, state => {
      if (tool === "project_context" && typeof data.context_id === "string") {
        state.context_id = data.context_id; state.context_at = Date.now();
        state.context_turn = interaction.turn_id ?? null;
        state.context_ready = !["not_scanned", "needs_rescan"].includes(String(data.state));
      }
      const taskId = typeof data.id === "string" ? data.id : typeof data.task_id === "string" ? data.task_id : undefined;
      if (tool.startsWith("task_") && taskId) {
        if (state.task_id !== taskId) {
          state.write_calls = 0; state.checked_calls = 0; state.check_outcome = null; state.pending_tools = []; state.completed_tools = [];
          // 新任务不能直接借用上一需求的查询记录。恢复同一任务仍按时间和本轮复核处理。
          if (tool === "task_open" && state.context_turn !== interaction.turn_id) state.context_ready = false;
        }
        state.task_id = taskId;
        if (typeof data.phase === "string") state.phase = data.phase;
        if ((tool === "task_check" && typeof data.review_snapshot === "string") || data.phase === "closed") {
          state.checked_calls = state.write_calls; state.check_outcome = value.outcome === "incomplete" ? "incomplete" : "ok";
        }
      }
    });
  }
  async status(project: string, interaction: InteractionContext, branch?: string | null) {
    const currentBranch = branch === undefined ? (await bindWorktree(project)).branch : branch;
    const saved = await this.read(project, interaction, currentBranch);
    const state = saved && Date.now() - saved.updated_at <= 24 * 60 * 60_000 ? saved : undefined;
    const thisTurn = !!state && !!interaction.turn_id && state.last_turn === interaction.turn_id;
    return { state: !state ? "unobserved" : state.pending_tools.length ? "write_in_progress" : state.write_calls > state.checked_calls ? "check_required"
      : !thisTurn ? "not_observed_this_turn" : state.phase === "closed" ? "closed" : state.phase === "aborted" ? "aborted" : state.phase === "suspended" ? "suspended" : state.check_outcome === "incomplete" ? "incomplete"
      : state.write_calls ? "checked" : state.task_id ? "task_bound" : state.context_id ? "context_queried" : "entry_only",
      guard_observed: state?.guard_seen ?? false, task_id: state?.task_id ?? null,
      current_turn_observed: thisTurn,
      write_tool_calls: state?.write_calls ?? 0, checked_write_tool_calls: state?.checked_calls ?? 0,
      evidence: "observed_tool_calls", counter_scope: "session_branch",
      limitation: "计数按当前会话及分支累积；current_turn_observed 才说明本轮有工具记录。经过流程不代表业务正确。" };
  }
}
