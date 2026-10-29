import { z } from "zod";
import { DiagnosticEvent } from "./contracts.js";

/** 接收端与插件共享严格白名单，不能靠“删除几个敏感字段”的黑名单上报。 */
export const DiagnosticBatch = z.object({ schema_version: z.literal(1), batch_id: z.string().regex(/^[a-f0-9]{64}$/),
  events: z.array(DiagnosticEvent).min(1).max(50),
}).strict().superRefine((batch, context) => {
  if (new Set(batch.events.map(event => event.install_id)).size !== 1)
    context.addIssue({ code: "custom", message: "每批只接受一个安装实例" });
  if (batch.events.some(event => !event.upload_epoch || new TextEncoder().encode(JSON.stringify(event)).byteLength > 4096))
    context.addIssue({ code: "custom", message: "远程事件须属于已启用周期，且大小有上限" });
});
