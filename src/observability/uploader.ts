import { createHash } from "node:crypto";
import { z } from "zod";
import { DIAGNOSTIC_NOTICE, RuntimeSettings, runtimeFiles } from "../runtime/config.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode } from "../storage/project-files.js";
import { DiagnosticWriter } from "./writer.js";
import { sendDiagnosticBatch } from "./transport.js";
import { uploadQueue } from "./upload-queue.js";

const CURSOR = "project-dev-agent/telemetry/upload.json";
const Cursor = z.object({ epoch: z.uuid(), positions: z.record(z.string(), z.number().int().nonnegative()),
  failures: z.number().int().min(0).max(10).default(0), next_attempt: z.number().nonnegative().default(0) }).strict();

/** 每批 50 条、最多四批共享发送预算；逐批确认后保存进度，不延长宿主收尾期限。 */
export async function uploadDiagnostics(home?: string, timeoutMs = 4000) {
  let release: (() => Promise<void>) | undefined;
  const deadline = performance.now() + (Number.isFinite(timeoutMs) ? Math.min(5000, Math.max(50, timeoutMs)) : 4000);
  let sent = 0;
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
    const queue = await uploadQueue(files, diagnostics.upload_epoch, positions);
    const unchanged = async () => {
      const current = (await settings.current()).diagnostics;
      return current.local && current.upload && current.upload_epoch === diagnostics.upload_epoch;
    };
    for (const page of queue.pages) {
      if (!await unchanged()) return { state: "configuration_changed", sent };
      const remaining = deadline - performance.now();
      // 不在耗尽总预算时启动下一批，避免积压清理占用更长宿主时间。
      if (remaining < 100) return { state: "pending", sent, invalid: queue.invalid };
      const batch = page.events;
      const batchId = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
      try {
        const ack = await sendDiagnosticBatch({ endpoint: diagnostics.endpoint, token: diagnostics.write_token, signal: controller.signal,
          body: JSON.stringify({ schema_version: 1, batch_id: batchId, events: batch }),
        });
        if (ack.batch_id !== batchId || ack.acknowledged !== batch.length) throw new Error("UPLOAD_ACK_MISMATCH");
        sent += batch.length;
      } catch (error) {
        if (await unchanged()) {
          failures = Math.min(10, failures + 1);
          await save({ epoch: diagnostics.upload_epoch, positions, failures,
            next_attempt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)) });
        }
        const reason = error instanceof Error && (/^UPLOAD_HTTP_[1-5][0-9]{2}$/.test(error.message)
          || ["UPLOAD_ACK_MISMATCH", "UPLOAD_RESPONSE_LIMIT", "UPLOAD_RESPONSE_INVALID", "UPLOAD_PROXY_INVALID"].includes(error.message)) ? error.message
          : error instanceof Error && error.name === "AbortError" ? "UPLOAD_TIMEOUT" : "UPLOAD_NETWORK_OR_RESPONSE";
        await new DiagnosticWriter(settings.home).record("telemetry.gap", { outcome: "degraded", reason });
        return { state: "unavailable", sent };
      } finally { clearTimeout(timer); }
      if (!await unchanged()) return { state: "configuration_changed", sent };
      positions = page.positions; failures = 0;
      await save({ epoch: diagnostics.upload_epoch, positions, failures: 0, next_attempt: 0 });
    }
    if (!await unchanged()) return { state: "configuration_changed", sent };
    await save({ epoch: diagnostics.upload_epoch, failures: 0, next_attempt: 0,
      positions: queue.positions });
    return { state: queue.pending ? "pending" : "ok", sent, invalid: queue.invalid };
  } catch {
    await new DiagnosticWriter(settings.home).record("telemetry.gap", { outcome: "degraded", reason: "UPLOAD_QUEUE_UNAVAILABLE" });
    return { state: "unavailable", sent };
  }
  finally { await release?.().catch(() => {}); }
}
