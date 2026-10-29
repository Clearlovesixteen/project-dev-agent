import { DiagnosticBatch } from "../../src/observability/batch.js";

// 仅部署在维护者的账户。终端插件包不包含此服务、数据库或读取凭证。
interface Statement { bind(...values: unknown[]): Statement; run(): Promise<unknown>; }
interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown[]>; }
interface Environment { DIAGNOSTICS_DB: Database; WRITE_TOKEN: string; }
const encoder = new TextEncoder();
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

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

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (new URL(request.url).pathname !== "/events" || request.method !== "POST") return json({ code: "NOT_FOUND" }, 404);
    if (!env.WRITE_TOKEN || env.WRITE_TOKEN.length < 16) return json({ code: "NOT_CONFIGURED" }, 503);
    // 比较固定长度摘要，不回显凭证或请求正文；写入令牌没有读取数据库的接口。
    if (await hash(request.headers.get("Authorization") ?? "") !== await hash(`Bearer ${env.WRITE_TOKEN}`)) return json({ code: "UNAUTHORIZED" }, 401);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ code: "CONTENT_TYPE" }, 415);
    try {
      const raw = await body(request), parsed = DiagnosticBatch.safeParse(raw);
      if (!parsed.success) return json({ code: "INVALID_BATCH" }, 400);
      const batch = parsed.data;
      // 校验发送方原 JSON 的摘要，Zod 默认值不能改变校验后的确认标识。
      if (await hash(JSON.stringify(raw.events)) !== batch.batch_id) return json({ code: "BATCH_HASH_MISMATCH" }, 400);
      const now = Date.now();
      if (batch.events.some(event => Date.parse(event.occurred_at) > now + 86_400_000 || Date.parse(event.occurred_at) < now - 31 * 86_400_000)) return json({ code: "EVENT_TIME_RANGE" }, 400);
      // D1 batch 原子提交；(install_id,event_id) 去重处理确认丢失后的重试。
      await env.DIAGNOSTICS_DB.batch(batch.events.map(event => env.DIAGNOSTICS_DB.prepare(
        "INSERT OR IGNORE INTO events (install_id,event_id,occurred_at,runtime_version,event_name,reason_code,trace_id,payload,received_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(event.install_id, event.event_id, event.occurred_at, event.runtime_version, event.event_name, event.reason_code,
          event.trace_id, JSON.stringify(event), new Date(now).toISOString())));
      return json({ batch_id: batch.batch_id, acknowledged: batch.events.length });
    } catch { return json({ code: "COLLECTOR_UNAVAILABLE" }, 503); }
  },
  async scheduled(_event: unknown, env: Environment) {
    await env.DIAGNOSTICS_DB.prepare("DELETE FROM events WHERE received_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run();
  },
};
