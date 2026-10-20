import { digest } from "../knowledge/document.js";
import { BatchSchema, PARSER_VERSION, type HistoryBatch, type HistoryMessage } from "./contracts.js";

// 分批算法升级不改变消息解析版本，旧批次及其分析仍可继续使用。
export const BATCHING_VERSION = 2;

/** 日志归档只改变 file；用户原话、顺序位置、时间和分段都仍需逐项一致。 */
function identity(message: HistoryMessage): string {
  return JSON.stringify([message.id, message.role, message.text, message.session, message.line, message.timestamp, message.part, message.parts]);
}

/** 保留当前快照中未变化的完整批次；新增消息单独切批，不重打包已纠正或已停用的分析。 */
export function batchMessages(messages: HistoryMessage[], project: string, previous: HistoryBatch[]): HistoryBatch[] {
  const starts = new Map<string, { batch: HistoryBatch; keys: string[] }[]>();
  for (const batch of previous) {
    const keys = batch.messages.map(identity), candidates = starts.get(keys[0]!) ?? [];
    candidates.push({ batch, keys }); starts.set(keys[0]!, candidates);
  }
  const keys = messages.map(identity), batches: HistoryBatch[] = [];
  let fresh: HistoryMessage[] = [], bytes = 0;
  const flush = () => {
    if (!fresh.length) return;
    const id = digest(JSON.stringify([PARSER_VERSION, BATCHING_VERSION, project, fresh.map(identity)])).slice(0, 32);
    batches.push(BatchSchema.parse({ id, project, messages: fresh })); fresh = []; bytes = 0;
  };
  for (let index = 0; index < messages.length;) {
    const retained = starts.get(keys[index]!)?.find((candidate) => candidate.keys.every((key, offset) => keys[index + offset] === key));
    if (retained) {
      flush(); batches.push(retained.batch); index += retained.keys.length; continue;
    }
    const message = messages[index++]!, size = Buffer.byteLength(JSON.stringify(message));
    if (bytes + size > 24_000 || fresh.length === 60) flush();
    fresh.push(message); bytes += size;
  }
  flush(); return batches;
}
