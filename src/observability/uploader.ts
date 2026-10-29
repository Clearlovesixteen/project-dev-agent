import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { z } from "zod";
import { DIAGNOSTIC_NOTICE, RuntimeSettings, runtimeFiles } from "../runtime/config.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode } from "../storage/project-files.js";
import { DiagnosticEvent, type TelemetryEvent } from "./contracts.js";
import { DiagnosticWriter, EVENT_DIRECTORY } from "./writer.js";

const CURSOR = "project-dev-agent/telemetry/upload.json";
const Cursor = z.object({ epoch: z.uuid(), positions: z.record(z.string(), z.number().int().nonnegative()),
  failures: z.number().int().min(0).max(10).default(0), next_attempt: z.number().nonnegative().default(0) }).strict();

/** 有界响应和禁止跳转，写入凭证不会被接收端重定向到其他域名。 */
async function acknowledgement(response: Response) {
  if (!response.ok) throw new Error(`UPLOAD_HTTP_${response.status}`);
  if (!response.body) throw new Error("UPLOAD_RESPONSE_INVALID");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4096) throw new Error("UPLOAD_RESPONSE_LIMIT");
      chunks.push(part.value);
    }
    return z.object({ batch_id: z.string(), acknowledged: z.number().int().nonnegative() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { await reader.cancel().catch(() => {}); }
}

/** 每次最多 50 条；确认落库后推进游标，失败退避，关闭后不会补传此前记录。 */
export async function uploadDiagnostics(home?: string, timeoutMs = 1500) {
  let release: (() => Promise<void>) | undefined;
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
    const positions = sameEpoch ? { ...prior.positions } : {} as Record<string, number>;
    const save = async (value: z.infer<typeof Cursor>) => {
      const next = JSON.stringify(value);
      if (previous !== undefined) await files.replace(CURSOR, next, previous); else await files.create(CURSOR, next);
    };
    const names: string[] = [];
    try {
      for await (const entry of await opendir(await files.path(EVENT_DIRECTORY))) {
        if (names.length >= 40) break;
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) names.push(entry.name);
      }
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    names.sort();
    const batch: TelemetryEvent[] = [];
    let invalid = 0;
    outer: for (const name of names) {
      const lines = (await files.read(`${EVENT_DIRECTORY}/${name}`, 1_056_768)).split("\n");
      // 无换行尾部可能仍在追加，不消费、不推进游标。
      for (let index = positions[name] ?? 0; index < lines.length - 1; index++) {
        positions[name] = index + 1;
        let event;
        try { event = DiagnosticEvent.safeParse(JSON.parse(lines[index]!)); } catch { invalid++; continue; }
        if (!event.success) { invalid++; continue; }
        // epoch 解决首次启用同毫秒、关闭后重开、切换接收端时的历史误上传。
        if (event.data.upload_epoch !== diagnostics.upload_epoch) continue;
        batch.push(event.data);
        if (batch.length === 50) break outer;
      }
    }
    const unchanged = async () => {
      const current = (await settings.current()).diagnostics;
      return current.local && current.upload && current.upload_epoch === diagnostics.upload_epoch;
    };
    if (!await unchanged()) return { state: "configuration_changed", sent: 0 };
    if (batch.length) {
      const batchId = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(5000, Math.max(50, timeoutMs)));
      try {
        const response = await fetch(diagnostics.endpoint, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${diagnostics.write_token}` },
          body: JSON.stringify({ schema_version: 1, batch_id: batchId, events: batch }),
        });
        const ack = await acknowledgement(response);
        if (ack.batch_id !== batchId || ack.acknowledged !== batch.length) throw new Error("UPLOAD_ACK_MISMATCH");
      } catch (error) {
        if (await unchanged()) {
          const failures = Math.min(10, (sameEpoch ? prior.failures : 0) + 1);
          await save({ epoch: diagnostics.upload_epoch, positions: sameEpoch ? prior.positions : {}, failures,
            next_attempt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)) });
        }
        const reason = error instanceof Error && (/^UPLOAD_HTTP_[1-5][0-9]{2}$/.test(error.message)
          || ["UPLOAD_ACK_MISMATCH", "UPLOAD_RESPONSE_LIMIT", "UPLOAD_RESPONSE_INVALID"].includes(error.message)) ? error.message
          : error instanceof Error && error.name === "AbortError" ? "UPLOAD_TIMEOUT" : "UPLOAD_NETWORK_OR_RESPONSE";
        await new DiagnosticWriter(settings.home).record("telemetry.gap", { outcome: "degraded", reason });
        return { state: "unavailable", sent: 0 };
      } finally { clearTimeout(timer); }
    }
    if (!await unchanged()) return { state: "configuration_changed", sent: batch.length };
    await save({ epoch: diagnostics.upload_epoch, failures: 0, next_attempt: 0,
      positions: Object.fromEntries(names.filter(name => positions[name] !== undefined).map(name => [name, positions[name]!])) });
    return { state: "ok", sent: batch.length, invalid };
  } catch { return { state: "unavailable", sent: 0 }; }
  finally { await release?.().catch(() => {}); }
}
