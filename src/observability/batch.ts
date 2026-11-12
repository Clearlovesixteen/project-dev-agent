import { z } from "zod";
import { DiagnosticEvent, LegacyDiagnosticEvent, type TelemetryEvent } from "./contracts.js";

/** 接收端与插件共享严格白名单，不能靠“删除几个敏感字段”的黑名单上报。 */
export const DiagnosticBatch = z.object({ schema_version: z.literal(1), batch_id: z.string().regex(/^[a-f0-9]{64}$/),
  events: z.array(LegacyDiagnosticEvent).min(1).max(50),
}).strict().superRefine((batch, context) => {
  if (new Set(batch.events.map(event => event.install_id)).size !== 1)
    context.addIssue({ code: "custom", message: "每批只接受一个安装实例" });
  if (batch.events.some(event => !event.upload_epoch || new TextEncoder().encode(JSON.stringify(event)).byteLength > 4096))
    context.addIssue({ code: "custom", message: "远程事件须属于已启用周期，且大小有上限" });
});

/** v2仅升级传输回执；事件自身仍为schema 1，旧入口继续使用冻结的完整白名单。 */
export const DiagnosticBatchV2 = z.object({ schema_version: z.literal(2), batch_id: z.string().regex(/^[a-f0-9]{64}$/),
  install_id: z.uuid(), events: z.array(z.unknown()).min(1).max(50),
}).strict();
export const RejectionReason = z.enum(["EVENT_SCHEMA", "EVENT_TOO_LARGE", "EVENT_TIME_RANGE", "EVENT_INSTALL_MISMATCH", "EVENT_UPLOAD_DISABLED"]);
export type RejectionReason = z.infer<typeof RejectionReason>;
export const BatchAcknowledgementV2 = z.object({ schema_version: z.literal(2), batch_id: z.string().regex(/^[a-f0-9]{64}$/),
  accepted_indexes: z.array(z.number().int().min(0).max(49)).max(50),
  rejected: z.array(z.object({ index: z.number().int().min(0).max(49), reason: RejectionReason }).strict()).max(50),
}).strict();
export type BatchAcknowledgementV2 = z.infer<typeof BatchAcknowledgementV2>;

/** 完整、互斥地确认每一项，缺项/重叠/越界均不能推进游标。 */
export function assertAcknowledgementV2(ack: BatchAcknowledgementV2, batchId: string, count: number) {
  const indexes = [...ack.accepted_indexes, ...ack.rejected.map(item => item.index)];
  if (ack.batch_id !== batchId || indexes.length !== count || new Set(indexes).size !== count || indexes.some(index => index >= count))
    throw new Error("UPLOAD_ACK_MISMATCH");
}

export const hasDiagnosticDetail = (event: TelemetryEvent) => ["context", "call_id", "operation_id", "workdir_id"].some(key => key in event);
/** 仅投影冻结白名单；不把未来未知字段自动送到旧接收端。 */
export function legacyDiagnosticProjection(event: TelemetryEvent) {
  return LegacyDiagnosticEvent.parse(Object.fromEntries(Object.keys(LegacyDiagnosticEvent.shape).map(key => [key, (event as unknown as Record<string, unknown>)[key]])));
}

/** 返回固定拒绝码，不向响应复制Zod错误、路径、原始输入或异常正文。 */
export function inspectRemoteEvent(raw: unknown, now: number, installId?: string): { event: TelemetryEvent } | { reason: RejectionReason } {
  if (new TextEncoder().encode(JSON.stringify(raw) ?? "").byteLength > 4096) return { reason: "EVENT_TOO_LARGE" };
  const parsed = DiagnosticEvent.safeParse(raw);
  if (!parsed.success) return { reason: "EVENT_SCHEMA" };
  if (installId && parsed.data.install_id !== installId) return { reason: "EVENT_INSTALL_MISMATCH" };
  if (!parsed.data.upload_epoch) return { reason: "EVENT_UPLOAD_DISABLED" };
  const at = Date.parse(parsed.data.occurred_at);
  if (at > now + 86_400_000 || at < now - 31 * 86_400_000) return { reason: "EVENT_TIME_RANGE" };
  return { event: parsed.data };
}
