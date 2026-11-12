import { DiagnosticBatch, DiagnosticBatchV2, inspectRemoteEvent, type BatchAcknowledgementV2 } from "../../src/observability/batch.js";
import type { TelemetryEvent } from "../../src/observability/contracts.js";
import { PUBLISHED_DIAGNOSTICS } from "../../src/runtime/published-diagnostics.js";
import { publicInstallAllowed, publicRequestAllowed, type PublicLimits } from "./public-ingest.js";

// 仅部署在维护者的账户。终端插件包不包含此服务、数据库或读取凭证。
interface Statement { bind(...values: unknown[]): Statement; run(): Promise<unknown>; }
interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown[]>; }
interface Environment extends PublicLimits { DIAGNOSTICS_DB: Database; WRITE_TOKEN?: string; }
const encoder = new TextEncoder();
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    ...(status === 429 ? { "Retry-After": "60" } : {}) } });

async function body(request: Request) {
  if (!request.body) throw new Error("EMPTY_BODY");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 220_000) throw new Error("BODY_LIMIT"); chunks.push(part.value); }
    const result = new Uint8Array(bytes); let offset = 0;
    for (const part of chunks) { result.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result));
  } finally { await reader.cancel().catch(() => {}); }
}

/** 空的有效集合无需D1写入；非空集合原子持久后才允许回执确认。 */
async function storeEvents(events: TelemetryEvent[], env: Environment, now: number, publicIngest: boolean) {
  if (!events.length) return;
  await env.DIAGNOSTICS_DB.batch(events.map(event => env.DIAGNOSTICS_DB.prepare(
    "INSERT OR IGNORE INTO events (install_id,event_id,occurred_at,runtime_version,event_name,reason_code,trace_id,payload,received_at,ingest_source) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(event.install_id, event.event_id, event.occurred_at, event.runtime_version, event.event_name, event.reason_code,
      event.trace_id, JSON.stringify(event), new Date(now).toISOString(), publicIngest ? "public" : "private")));
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname, publicIngest = path === "/public/events" || path === "/public/events/v2", v2 = path.endsWith("/v2");
    if (!["/events", "/public/events", "/events/v2", "/public/events/v2"].includes(path) || request.method !== "POST") return json({ code: "NOT_FOUND" }, 404);
    const token = publicIngest ? PUBLISHED_DIAGNOSTICS.ingest_key : env.WRITE_TOKEN;
    if (!token || token.length < 16) return json({ code: "NOT_CONFIGURED" }, 503);
    // 比较固定长度摘要，不回显凭证或请求正文；写入令牌没有读取数据库的接口。
    if (await hash(request.headers.get("Authorization") ?? "") !== await hash(`Bearer ${token}`)) return json({ code: "UNAUTHORIZED" }, 401);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ code: "CONTENT_TYPE" }, 415);
    try {
      if (publicIngest && !await publicRequestAllowed(request, env)) return json({ code: "RATE_LIMITED" }, 429);
      const raw = await body(request), now = Date.now();
      if (v2) {
        const envelope = DiagnosticBatchV2.safeParse(raw);
        if (!envelope.success) return json({ code: "INVALID_BATCH" }, 400);
        const batch = envelope.data;
        if (await hash(JSON.stringify(raw.events)) !== batch.batch_id) return json({ code: "BATCH_HASH_MISMATCH" }, 400);
        if (publicIngest && !await publicInstallAllowed(batch.install_id, env)) return json({ code: "RATE_LIMITED" }, 429);
        const ack: BatchAcknowledgementV2 = { schema_version: 2, batch_id: batch.batch_id, accepted_indexes: [], rejected: [] }, accepted: TelemetryEvent[] = [];
        batch.events.forEach((rawEvent, index) => {
          const checked = inspectRemoteEvent(rawEvent, now, batch.install_id);
          if ("reason" in checked) ack.rejected.push({ index, reason: checked.reason });
          else { accepted.push(checked.event); ack.accepted_indexes.push(index); }
        });
        await storeEvents(accepted, env, now, publicIngest);
        return json(ack);
      }
      const parsed = DiagnosticBatch.safeParse(raw);
      if (!parsed.success) return json({ code: "INVALID_BATCH" }, 400);
      const batch = parsed.data;
      // 校验发送方原 JSON 的摘要，Zod 默认值不能改变校验后的确认标识。
      if (await hash(JSON.stringify(raw.events)) !== batch.batch_id) return json({ code: "BATCH_HASH_MISMATCH" }, 400);
      if (batch.events.some(event => Date.parse(event.occurred_at) > now + 86_400_000 || Date.parse(event.occurred_at) < now - 31 * 86_400_000)) return json({ code: "EVENT_TIME_RANGE" }, 400);
      if (publicIngest && !await publicInstallAllowed(batch.events[0]!.install_id, env)) return json({ code: "RATE_LIMITED" }, 429);
      // D1 batch 原子提交；(install_id,event_id) 去重处理确认丢失后的重试。
      await storeEvents(batch.events, env, now, publicIngest);
      return json({ batch_id: batch.batch_id, acknowledged: batch.events.length });
    } catch { return json({ code: "COLLECTOR_UNAVAILABLE" }, 503); }
  },
  async scheduled(_event: unknown, env: Environment) {
    await env.DIAGNOSTICS_DB.prepare("DELETE FROM events WHERE received_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run();
  },
};
