import { constants } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, opendir, unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { RuntimeSettings, runtimeFiles } from "../runtime/config.js";
import { hasCode, type ProjectFiles } from "../storage/project-files.js";
import { VERSION } from "../version.js";
import { DiagnosticEvent, type TelemetryAttributes, type TelemetryEvent } from "./contracts.js";
import { currentInteraction } from "../workflow/interaction.js";
import { bestEffort } from "../runtime/best-effort.js";

const ROOT = "project-dev-agent/telemetry";
const Identity = z.object({ install_id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const EVENT_DIRECTORY = `${ROOT}/events`;
const MAX_DAY_BYTES = 1_048_576;
const RETENTION_MS = 30 * 86_400_000;

/** 每日一个有界 JSONL；单次 O_APPEND 写入一行，避免多个进程相互覆盖。 */
export class DiagnosticWriter {
  readonly home: string;
  private readonly suppressed: boolean;
  constructor(home?: string) {
    this.home = home ?? new RuntimeSettings().home;
    // 测试必须显式传入隔离目录，不能将测试运行写入开发者的真实诊断。
    this.suppressed = !home && !!process.env.NODE_TEST_CONTEXT && !process.env.CODEX_HOME;
  }
  private async identity(files: ProjectFiles) {
    const path = `${ROOT}/identity.json`;
    try { return Identity.parse(JSON.parse(await files.read(path))); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const identity = { install_id: randomUUID(), secret: randomBytes(32).toString("hex") };
      try { await files.create(path, JSON.stringify(identity)); return identity; }
      catch (failure) {
        if (!(failure instanceof Error && "code" in failure && failure.code === "FILE_EXISTS")) throw failure;
        return Identity.parse(JSON.parse(await files.read(path)));
      }
    }
  }
  async opaque(value: string): Promise<string> {
    const identity = await this.identity(await runtimeFiles(this.home));
    return createHmac("sha256", identity.secret).update(value).digest("hex");
  }
  async record(name: TelemetryEvent["event_name"], input: {
    project?: string; session?: string; task?: string; trace?: string;
    outcome?: TelemetryEvent["outcome"]; reason?: string; duration?: number;
    evidence?: TelemetryEvent["evidence_level"]; attributes?: TelemetryAttributes;
  } = {}): Promise<boolean> {
    try {
      if (this.suppressed) return false;
      const config = await new RuntimeSettings(this.home).current();
      if (!config.diagnostics.local) return false;
      const files = await runtimeFiles(this.home), identity = await this.identity(files);
      const hash = (value: string) => createHmac("sha256", identity.secret).update(value).digest("hex");
      const event = DiagnosticEvent.parse({
        schema_version: 1, event_id: randomUUID(), occurred_at: new Date().toISOString(), event_name: name,
        upload_epoch: config.diagnostics.upload ? config.diagnostics.upload_epoch : null,
        install_id: identity.install_id, trace_id: hash(input.trace ?? randomUUID()),
        project_id: input.project ? hash(input.project) : null, session_id: input.session ? hash(input.session) : null,
        task_id: input.task ? hash(input.task) : null, runtime_version: VERSION, policy_version: 1, mode: config.mode,
        outcome: input.outcome ?? "ok", reason_code: input.reason ?? "OK", duration_ms: input.duration ?? 0,
        evidence_level: input.evidence ?? "observed", attributes: input.attributes ?? {},
      });
      const line = JSON.stringify(event) + "\n";
      if (Buffer.byteLength(line) > 4096) return false;
      await files.directory(EVENT_DIRECTORY);
      const path = await files.path(`${EVENT_DIRECTORY}/${event.occurred_at.slice(0, 10)}.jsonl`, true);
      const handle = await open(path, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size + Buffer.byteLength(line) > MAX_DAY_BYTES) return false;
        await handle.write(Buffer.from(line));
      } finally { await handle.close(); }
      return true;
    } catch { return false; } // 采集异常不改变原工具或业务操作的结果。
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
  }
}

/** 包装仅统计本插件动作；结构化 error 和 incomplete 不能被一次正常 Promise 完成掩盖。 */
export async function observeTool<T>(writer: DiagnosticWriter, tool: NonNullable<TelemetryAttributes["tool"]>, project: string | undefined,
  action: () => Promise<T>, transport: "mcp" | "cli" = "mcp"): Promise<T> {
  const started = performance.now(), interaction = currentInteraction(), trace = interaction?.turn_id ?? interaction?.operation_id ?? randomUUID();
  try {
    const result = await action(), envelope = (result && typeof result === "object" ? result : {}) as { structuredContent?: { outcome?: string; code?: string; data?: Record<string, unknown> }; outcome?: string; code?: string; data?: Record<string, unknown> };
    const value = envelope.structuredContent ?? envelope;
    const task = tool.startsWith("task_") && typeof value.data?.id === "string" ? value.data.id
      : typeof value.data?.task_id === "string" ? value.data.task_id : undefined;
    await bestEffort(async () => {
    await writer.record("tool.finished", { ...(project ? { project } : {}), ...(interaction ? { session: interaction.session_id } : {}), trace, duration: performance.now() - started,
      ...(task ? { task } : {}),
      outcome: value.outcome === "error" ? "error" : value.outcome === "incomplete" ? "incomplete" : "ok",
      reason: value.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) ? value.code : "OK", attributes: { tool, transport } });
    const eventName = tool === "task_open" ? value.code === "TASK_OPENED" ? "workflow.bound" : undefined : tool === "task_update" ? "task.transitioned"
      : tool === "task_check" ? "quality.checked" : tool === "project_model_record" || tool === "project_model_apply" ? "model.changed"
      : tool === "project_feedback_record" || tool === "feedback_record" ? "feedback.recorded" : tool === "project_context" ? "context.lookup" : undefined;
    if (eventName && value.outcome !== "error") {
      const spec = value.data?.spec_input as { kind?: TelemetryAttributes["input_kind"] } | undefined;
      await writer.record(eventName, { ...(project ? { project } : {}), ...(interaction ? { session: interaction.session_id } : {}), trace,
        ...(task ? { task } : {}),
        outcome: value.outcome === "incomplete" ? "incomplete" : "ok", attributes: { tool, transport,
          ...(spec?.kind ? { input_kind: spec.kind } : {}),
          ...(Array.isArray(value.data?.files) ? { selected_count: value.data.files.length } : {}),
          ...(typeof value.data?.context_id === "string" ? { context_id: value.data.context_id } : {}), coverage: "partial" } });
    }
    });
    return result;
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : "TOOL_FAILED";
    await bestEffort(() => writer.record("tool.finished", { ...(project ? { project } : {}), ...(interaction ? { session: interaction.session_id } : {}), trace, duration: performance.now() - started, outcome: "error", reason, attributes: { tool, transport } }));
    throw error;
  }
}
