import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DIAGNOSTIC_NOTICE, RuntimeSettings, runtimeFiles } from "../runtime/config.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode } from "../storage/project-files.js";
import { DiagnosticWriter } from "./writer.js";
import { DiagnosticHttpError, DiagnosticTimeoutError, DiagnosticTransport } from "./transport.js";
import { uploadQueue, type UploadPage } from "./upload-queue.js";
import { assertAcknowledgementV2, hasDiagnosticDetail, legacyDiagnosticProjection, type BatchAcknowledgementV2 } from "./batch.js";
import { saveUploadReceipt } from "./upload-receipts.js";
import { bestEffort } from "../runtime/best-effort.js";

const CURSOR = "project-dev-agent/telemetry/upload.json";
const Cursor = z.object({ epoch: z.uuid(), positions: z.record(z.string(), z.number().int().nonnegative()),
  failures: z.number().int().min(0).max(10).default(0), next_attempt: z.number().nonnegative().default(0) }).strict();

/** 同一次失败上报共享追踪标识；积压只统计当前读取窗口内尚未确认的事件。 */
async function recordTimeout(writer: DiagnosticWriter, reason: string, duration: number, pages: UploadPage[], pending: boolean, attempt: number) {
  const oldest = Math.min(...pages.flatMap(page => page.events.map(event => Date.parse(event.occurred_at))));
  const trace = randomUUID();
  const attributes = { transport: "cli" as const, attempt, truncated: pending,
    candidate_count: pages.reduce((total, page) => total + page.events.length, 0), selected_count: pages[0]?.events.length ?? 0 };
  const context = { version: 1 as const, stage: "upload" as const };
  await bestEffort(() => Promise.all([
    writer.record("telemetry.gap", { trace, outcome: "degraded", reason, duration, attributes, context: { ...context, decision: "degraded" } }),
    writer.record("health.checked", { trace, reason: "UPLOAD_QUEUE_AGE",
      duration: Math.min(86_400_000, Math.max(0, Date.now() - oldest)), attributes, context }),
  ]), 150);
}

/** 每批最多 50 条，确认后保存游标；退避重试缩小批次并沿用宿主收尾期限。 */
export async function uploadDiagnostics(home?: string, timeoutMs = 4000) {
  let release: (() => Promise<void>) | undefined;
  let transport: DiagnosticTransport | undefined;
  const deadline = performance.now() + (Number.isFinite(timeoutMs) ? Math.min(5000, Math.max(50, timeoutMs)) : 4000);
  let sent = 0, rejected = 0, omitted = 0, legacyOnly = false;
  const settings = new RuntimeSettings(home);
  try {
    const diagnostics = (await settings.current()).diagnostics;
    if (!diagnostics.local || !diagnostics.upload || diagnostics.notice_version !== DIAGNOSTIC_NOTICE
      || !diagnostics.endpoint || !diagnostics.write_token || !diagnostics.upload_epoch) return { state: "disabled", sent: 0 };
    const files = await runtimeFiles(settings.home);
    await files.directory("project-dev-agent/telemetry");
    try { release = await acquireFileLock(files, "project-dev-agent/telemetry/upload.lock", "UPLOAD_BUSY"); }
    catch (error) { if (hasCode(error, "UPLOAD_BUSY")) return { state: "busy", sent: 0 }; throw error; }
    let previous: string | undefined;
    try { previous = await files.read(CURSOR); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    const prior = previous ? Cursor.parse(JSON.parse(previous)) : undefined;
    const sameEpoch = prior?.epoch === diagnostics.upload_epoch;
    if (sameEpoch && prior.next_attempt > Date.now()) return { state: "backoff", sent: 0 };
    let positions = sameEpoch ? { ...prior.positions } : {} as Record<string, number>;
    let failures = sameEpoch ? prior.failures : 0;
    const save = async (value: z.infer<typeof Cursor>) => {
      const next = JSON.stringify(value);
      if (previous !== undefined) await files.replace(CURSOR, next, previous); else await files.create(CURSOR, next);
      previous = next;
    };
    // 复用已有失败计数，退避期间逐步减小批次，也能读取旧版保存的游标。
    const batchSize = Math.max(10, Math.floor(50 / 2 ** failures));
    const queue = await uploadQueue(files, diagnostics.upload_epoch, positions, batchSize);
    transport = new DiagnosticTransport(diagnostics.endpoint);
    const sender = transport;
    const unchanged = async () => {
      const current = (await settings.current()).diagnostics;
      return current.local && current.upload && current.upload_epoch === diagnostics.upload_epoch;
    };
    for (const [pageIndex, page] of queue.pages.entries()) {
      if (!await unchanged()) return { state: "configuration_changed", sent };
      const started = performance.now(), remaining = deadline - started;
      // 不在耗尽总预算时启动下一批，避免积压清理占用更长宿主时间。
      if (remaining < 100) return { state: "pending", sent, invalid: queue.invalid };
      const batch = page.events;
      const batchId = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
      try {
        let accepted = 0, pageOmitted = 0, pageRejected: BatchAcknowledgementV2["rejected"] = [];
        const detailed = batch.filter(hasDiagnosticDetail).length;
        const sendLegacy = async () => {
          controller.signal.throwIfAborted();
          if (!await unchanged()) throw new Error("UPLOAD_CONFIGURATION_CHANGED");
          const events = batch.map(legacyDiagnosticProjection), projectedId = createHash("sha256").update(JSON.stringify(events)).digest("hex");
          const ack = await sender.send({ endpoint: diagnostics.endpoint!, token: diagnostics.write_token!, signal: controller.signal,
            body: JSON.stringify({ schema_version: 1, batch_id: projectedId, events }) });
          if (!("acknowledged" in ack) || ack.batch_id !== projectedId || ack.acknowledged !== events.length) throw new Error("UPLOAD_ACK_MISMATCH");
          accepted = events.length; pageOmitted = detailed;
        };
        if (batch.length && detailed && !legacyOnly) {
          const endpoint = new URL(diagnostics.endpoint); endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/v2";
          try {
            const ack = await sender.send({ endpoint: endpoint.href, token: diagnostics.write_token, signal: controller.signal, profile: 2,
              body: JSON.stringify({ schema_version: 2, batch_id: batchId, install_id: batch[0]!.install_id, events: batch }) });
            if (!("schema_version" in ack)) throw new Error("UPLOAD_ACK_MISMATCH");
            assertAcknowledgementV2(ack, batchId, batch.length);
            accepted = ack.accepted_indexes.length; pageRejected = ack.rejected;
          } catch (error) {
            // 仅独立v2路径明确不存在时降级一次；400/认证/限流/数据库失败绝不能被当成坏数据跳过。
            if (!(error instanceof DiagnosticHttpError) || ![404, 405].includes(error.status)) throw error;
            legacyOnly = true; await sendLegacy();
          }
        } else if (batch.length) await sendLegacy();
        sent += accepted;
        if (!await unchanged()) return { state: "configuration_changed", sent };
        if (pageRejected.length || page.discarded.length || pageOmitted) {
          // 无事件的本地坏行页用位置摘要区分；任何拒绝/降级证据写盘失败均保留旧游标，可幂等重试。
          const receiptId = batch.length ? batchId : createHash("sha256").update(JSON.stringify(page.positions)).digest("hex");
          await saveUploadReceipt(files, { batch_id: receiptId, epoch: diagnostics.upload_epoch, at: new Date().toISOString(),
            accepted_count: accepted, omitted_detail_count: pageOmitted, rejected: pageRejected, local_rejections: page.discarded });
          rejected += pageRejected.length; omitted += pageOmitted;
        }
      } catch (error) {
        if (!await unchanged()) return { state: "configuration_changed", sent };
        {
          failures = Math.min(10, failures + 1);
          await save({ epoch: diagnostics.upload_epoch, positions, failures,
            next_attempt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)) });
        }
        const writer = new DiagnosticWriter(settings.home);
        if (error instanceof DiagnosticTimeoutError || error instanceof Error && error.name === "AbortError") {
          const reason = error instanceof DiagnosticTimeoutError ? error.code : "UPLOAD_TIMEOUT";
          await recordTimeout(writer, reason, performance.now() - started, queue.pages.slice(pageIndex), queue.pending, failures);
        } else {
          const reason = error instanceof Error && (/^UPLOAD_HTTP_[1-5][0-9]{2}$/.test(error.message)
            || ["UPLOAD_ACK_MISMATCH", "UPLOAD_RESPONSE_LIMIT", "UPLOAD_RESPONSE_INVALID", "UPLOAD_PROXY_INVALID"].includes(error.message))
            ? error.message : "UPLOAD_NETWORK_OR_RESPONSE";
          await writer.record("telemetry.gap", { outcome: "degraded", reason });
        }
        return { state: "unavailable", sent };
      } finally { clearTimeout(timer); }
      if (!await unchanged()) return { state: "configuration_changed", sent };
      positions = page.positions; failures = 0;
      await save({ epoch: diagnostics.upload_epoch, positions, failures: 0, next_attempt: 0 });
    }
    if (!await unchanged()) return { state: "configuration_changed", sent };
    await save({ epoch: diagnostics.upload_epoch, failures: 0, next_attempt: 0,
      positions: queue.positions });
    if (rejected || queue.invalid || omitted) await bestEffort(() => new DiagnosticWriter(settings.home).record("telemetry.gap", {
      outcome: "degraded", reason: omitted ? "UPLOAD_V1_CONTEXT_OMITTED" : "UPLOAD_EVENTS_REJECTED",
      attributes: { selected_count: rejected + queue.invalid, candidate_count: omitted, transport: "cli" } }), 50);
    return { state: queue.pending ? "pending" : rejected || queue.invalid || omitted ? "partial" : "ok", sent, invalid: queue.invalid, rejected, omitted };
  } catch {
    await new DiagnosticWriter(settings.home).record("telemetry.gap", { outcome: "degraded", reason: "UPLOAD_QUEUE_UNAVAILABLE" });
    return { state: "unavailable", sent };
  }
  finally {
    await transport?.close();
    await release?.().catch(() => {});
  }
}
