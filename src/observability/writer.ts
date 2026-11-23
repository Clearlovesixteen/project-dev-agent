import { constants } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, opendir, unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { RuntimeSettings, runtimeFiles, type RuntimeConfig } from "../runtime/config.js";
import { hasCode, type ProjectFiles } from "../storage/project-files.js";
import { VERSION } from "../version.js";
import { DiagnosticEvent, type TelemetryAttributes, type TelemetryEvent } from "./contracts.js";
import { DiagnosticContext } from "./diagnostic-context.js";
import { toolDiagnosticContext } from "./tool-context.js";
import { pruneUploadReceipts } from "./upload-receipts.js";
import { currentInteraction } from "../workflow/interaction.js";
import { bestEffort } from "../runtime/best-effort.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = "project-dev-agent/telemetry";
const IdentitySchema = z.object({ install_id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Identity = z.infer<typeof IdentitySchema>;
export const EVENT_DIRECTORY = `${ROOT}/events`;
const MAX_DAY_BYTES = 1_048_576;
const RETENTION_MS = 30 * 86_400_000;
const appendQueues = new Map<string, Promise<void>>();

/** 同一进程内先排队，跨 hook 进程再用文件锁串行化按日大小检查和追加。 */
async function withAppendLock<T>(key: string, files: ProjectFiles, lockPath: string, action: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>(resolve => { releaseQueue = resolve; });
  appendQueues.set(key, queued);
  await previous;
  let releaseFile: (() => Promise<void>) | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        releaseFile = await acquireFileLock(files, lockPath, "DIAGNOSTIC_WRITE_BUSY");
        break;
      } catch (error) {
        if (!hasCode(error, "DIAGNOSTIC_WRITE_BUSY") || attempt >= 5) throw error;
        await delay(5);
      }
    }
    return await action();
  } finally {
    await releaseFile?.().catch(() => {});
    releaseQueue();
    if (appendQueues.get(key) === queued) appendQueues.delete(key);
  }
}

export type DiagnosticRecordInput = {
  project?: string; session?: string; task?: string; trace?: string;
  call?: string; operation?: string; workdir?: string; context?: DiagnosticContext;
  outcome?: TelemetryEvent["outcome"]; reason?: string; duration?: number;
  evidence?: TelemetryEvent["evidence_level"]; attributes?: TelemetryAttributes;
};
type DiagnosticRecord = { name: TelemetryEvent["event_name"]; input: DiagnosticRecordInput };

/** 业务工具通常只返回三态结果，但保留已存在的诊断结果，避免派生事件被误记为成功。 */
function diagnosticOutcome(value: unknown): TelemetryEvent["outcome"] {
  return value === "ok" || value === "skipped" || value === "degraded" || value === "error" || value === "incomplete"
    ? value
    : "ok";
}

/** 每日一个有界 JSONL；单次 O_APPEND 写入一行，避免多个进程相互覆盖。 */
export class DiagnosticWriter {
  readonly home: string;
  private readonly suppressed: boolean;
  private readonly configuration: RuntimeConfig | undefined;
  private filesPromise?: Promise<ProjectFiles>;
  private identityPromise?: Promise<Identity>;
  constructor(home?: string, configuration?: RuntimeConfig) {
    this.home = home ?? new RuntimeSettings().home;
    this.configuration = configuration;
    // 测试必须显式传入隔离目录，不能将测试运行写入开发者的真实诊断。
    this.suppressed = !home && !!process.env.NODE_TEST_CONTEXT && !process.env.CODEX_HOME;
  }
  private async files() {
    return this.filesPromise ??= runtimeFiles(this.home);
  }
  private async identity(files: ProjectFiles) {
    if (this.identityPromise) return this.identityPromise;
    this.identityPromise = this.loadIdentity(files);
    return this.identityPromise;
  }
  private async loadIdentity(files: ProjectFiles) {
    const path = `${ROOT}/identity.json`;
    try { return IdentitySchema.parse(JSON.parse(await files.read(path))); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const identity = { install_id: randomUUID(), secret: randomBytes(32).toString("hex") };
      try { await files.create(path, JSON.stringify(identity)); return identity; }
      catch (failure) {
        if (!(failure instanceof Error && "code" in failure && failure.code === "FILE_EXISTS")) throw failure;
        return IdentitySchema.parse(JSON.parse(await files.read(path)));
      }
    }
  }
  async opaque(value: string): Promise<string> {
    const identity = await this.identity(await this.files());
    return createHmac("sha256", identity.secret).update(value).digest("hex");
  }
  private createEvent(name: TelemetryEvent["event_name"], input: DiagnosticRecordInput, config: RuntimeConfig, identity: Identity) {
    const hash = (value: string) => createHmac("sha256", identity.secret).update(value).digest("hex");
    // 调用事实使用单次身份读取去标识；无原文、路径或任意工具参数进入上下文。
    const context = input.context ? DiagnosticContext.safeParse({ ...input.context,
      node_version: process.versions.node, platform: process.platform, arch: process.arch }) : undefined;
    const event = DiagnosticEvent.parse({
      schema_version: 1, event_id: randomUUID(), occurred_at: new Date().toISOString(), event_name: name,
      upload_epoch: config.diagnostics.upload ? config.diagnostics.upload_epoch : null,
      install_id: identity.install_id, trace_id: hash(input.trace ?? randomUUID()),
      project_id: input.project ? hash(input.project) : null, session_id: input.session ? hash(input.session) : null,
      task_id: input.task ? hash(input.task) : null, runtime_version: VERSION, policy_version: 1, mode: config.mode,
      outcome: input.outcome ?? "ok", reason_code: input.reason ?? "OK", duration_ms: input.duration ?? 0,
      evidence_level: input.evidence ?? "observed", attributes: input.attributes ?? {},
      ...(input.call ? { call_id: hash(input.call) } : {}), ...(input.operation ? { operation_id: hash(input.operation) } : {}),
      ...(input.workdir ? { workdir_id: hash(input.workdir) } : {}),
      ...(context?.success ? { context: context.data } : {}),
    });
    const line = JSON.stringify(event) + "\n";
    return Buffer.byteLength(line) <= 4096 ? { event, line } : undefined;
  }
  async recordMany(entries: readonly DiagnosticRecord[]): Promise<boolean> {
    try {
      if (this.suppressed || !entries.length) return false;
      const config = this.configuration ?? await new RuntimeSettings(this.home).current();
      if (!config.diagnostics.local) return false;
      const files = await this.files(), identity = await this.identity(files);
      const grouped = new Map<string, string[]>();
      for (const entry of entries) {
        try {
          const created = this.createEvent(entry.name, entry.input, config, identity);
          if (!created) continue;
          const date = created.event.occurred_at.slice(0, 10);
          const lines = grouped.get(date) ?? [];
          lines.push(created.line); grouped.set(date, lines);
        } catch { /* 单条诊断格式异常不能丢掉同一批的其他事件。 */ }
      }
      if (!grouped.size) return false;
      await files.directory(EVENT_DIRECTORY);
      let written = false;
      for (const [date, lines] of grouped) {
        const eventPath = `${EVENT_DIRECTORY}/${date}.jsonl`, path = await files.path(eventPath, true);
        const key = `${this.home}:${eventPath}`;
        const accepted = await withAppendLock(key, files, `${eventPath}.lock`, async () => {
          const handle = await open(path, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) return false;
            let size = stat.size, selected: string[] = [];
            for (const line of lines) {
              const bytes = Buffer.byteLength(line);
              if (size + bytes > MAX_DAY_BYTES) break;
              selected.push(line); size += bytes;
            }
            if (selected.length) await handle.write(Buffer.from(selected.join("")));
            return selected.length > 0;
          } finally { await handle.close(); }
        });
        written ||= accepted;
      }
      return written;
    } catch { return false; } // 采集异常不改变原工具或业务操作的结果。
  }

  async record(name: TelemetryEvent["event_name"], input: DiagnosticRecordInput = {}): Promise<boolean> {
    return this.recordMany([{ name, input }]);
  }

  /** 只读有限明细；损坏尾行和保留期缺口单独报告，绝不把空数据当成没有问题。 */
  async read(from?: string, to?: string) {
    const files = await runtimeFiles(this.home), events: TelemetryEvent[] = [];
    let invalid = 0, truncated = false;
    let directory;
    try { directory = await opendir(await files.path(EVENT_DIRECTORY)); }
    catch (error) { if (hasCode(error, "ENOENT")) return { events, invalid, truncated }; throw error; }
    let count = 0;
    for await (const entry of directory) {
      if (++count > 40) { truncated = true; break; }
      // 追加锁和事件文件同目录，锁不是诊断数据，不能因为读时恰好存在就增加 invalid。
      if (/^\d{4}-\d{2}-\d{2}\.jsonl\.lock(?:\.recover)?$/.test(entry.name)) continue;
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) { invalid++; continue; }
      if (Date.parse(entry.name.slice(0, 10)) < Date.now() - RETENTION_MS) continue;
      const raw = await files.read(`${EVENT_DIRECTORY}/${entry.name}`, MAX_DAY_BYTES + 8192);
      for (const line of raw.split("\n").filter(Boolean)) {
        let parsed;
        try { parsed = DiagnosticEvent.safeParse(JSON.parse(line)); } catch { invalid++; continue; }
        if (!parsed.success) { invalid++; continue; }
        if (from && parsed.data.occurred_at < from || to && parsed.data.occurred_at >= to) continue;
        if (events.length >= 20_000) { truncated = true; break; }
        events.push(parsed.data);
      }
    }
    return { events: [...new Map(events.map((event) => [event.event_id, event])).values()], invalid, truncated };
  }

  async prune() {
    const files = await runtimeFiles(this.home);
    try {
      let count = 0;
      for await (const entry of await opendir(await files.path(EVENT_DIRECTORY))) {
        if (++count > 80) break;
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name) && Date.parse(entry.name.slice(0, 10)) < Date.now() - RETENTION_MS) {
          await unlink(await files.path(`${EVENT_DIRECTORY}/${entry.name}`));
        }
      }
    } catch { /* 清理失败不影响开发；诊断读取会显示保留范围。 */ }
    await pruneUploadReceipts(files).catch(() => {});
  }
}

/** 包装仅统计本插件动作；结构化 error 和 incomplete 不能被一次正常 Promise 完成掩盖。 */
export async function observeTool<T>(writer: DiagnosticWriter, tool: NonNullable<TelemetryAttributes["tool"]>, project: string | undefined,
  action: () => Promise<T>, transport: "mcp" | "cli" = "mcp",
  metadata: { task_id?: string; input_kind?: TelemetryAttributes["input_kind"]; context?: DiagnosticContext } = {}): Promise<T> {
  const call = randomUUID(), started = performance.now(), interaction = currentInteraction(), trace = interaction?.turn_id ?? interaction?.operation_id ?? randomUUID();
  try {
    const result = await action();
    // 诊断提取与写入一起降级，不能让遥测异常把业务成功改成失败。
    await bestEffort(async () => {
    const envelope = (result && typeof result === "object" ? result : {}) as { structuredContent?: { outcome?: string; code?: string; data?: Record<string, unknown> }; outcome?: string; code?: string; data?: Record<string, unknown> };
    const value = envelope.structuredContent ?? envelope;
    const task = tool.startsWith("task_") && typeof value.data?.id === "string" ? value.data.id
      : typeof value.data?.task_id === "string" ? value.data.task_id : metadata.task_id;
    const context = toolDiagnosticContext(tool, metadata.context, value, interaction);
    await writer.record("tool.finished", { ...(project ? { project } : {}), ...(interaction ? { session: interaction.session_id } : {}), trace, call, ...(interaction?.operation_id ? { operation: interaction.operation_id } : {}), context, duration: performance.now() - started,
      ...(task ? { task } : {}),
      outcome: diagnosticOutcome(value.outcome),
      reason: value.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) ? value.code : "OK", attributes: { tool, transport } });
    const eventName = tool === "task_open" ? value.code === "TASK_OPENED" ? "workflow.bound" : undefined : tool === "task_update" ? "task.transitioned"
      : tool === "task_check" && value.data?.mode !== "resume" ? "quality.checked" : tool === "project_model_record" || tool === "project_model_apply" ? "model.changed"
      : tool === "project_feedback_record" || tool === "feedback_record" ? "feedback.recorded" : tool === "project_context" ? "context.lookup" : undefined;
    if (eventName && value.outcome !== "error") {
      const spec = value.data?.spec_input as { kind?: TelemetryAttributes["input_kind"] } | undefined;
      await writer.record(eventName, { ...(project ? { project } : {}), ...(interaction ? { session: interaction.session_id } : {}), trace, call, context,
        ...(task ? { task } : {}),
        reason: value.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) ? value.code : "OK",
        outcome: diagnosticOutcome(value.outcome), attributes: { tool, transport,
          ...(spec?.kind || metadata.input_kind ? { input_kind: spec?.kind ?? metadata.input_kind } : tool === "task_open" ? { input_kind: "request" as const } : {}),
          ...(["active", "suspended", "closed", "aborted"].includes(String(value.data?.phase)) ? { phase: value.data!.phase as NonNullable<TelemetryAttributes["phase"]> } : {}),
          ...(Array.isArray(value.data?.files) ? { selected_count: value.data.files.length } : {}),
          ...(typeof value.data?.context_id === "string" ? { context_id: value.data.context_id } : {}), coverage: "partial" } });
    }
    });
    return result;
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : "TOOL_FAILED";
    await bestEffort(() => writer.record("tool.finished", { ...(project ? { project } : {}), ...(metadata.task_id ? { task: metadata.task_id } : {}), ...(interaction ? { session: interaction.session_id } : {}), trace, call, context: toolDiagnosticContext(tool, metadata.context, { outcome: "error", code: reason }, interaction), duration: performance.now() - started, outcome: "error", reason, attributes: { tool, transport } }));
    throw error;
  }
}
