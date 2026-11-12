import { z } from "zod";
import type { ProjectFiles } from "../storage/project-files.js";
import { hasCode } from "../storage/project-files.js";
import { RejectionReason } from "./batch.js";
import { acquireFileLock } from "../storage/file-lock.js";

const Receipt = z.object({ batch_id: z.string().regex(/^[a-f0-9]{64}$/), epoch: z.uuid(), at: z.string().datetime(),
  accepted_count: z.number().int().min(0).max(50), omitted_detail_count: z.number().int().min(0).max(50),
  rejected: z.array(z.object({ index: z.number().int().min(0).max(49), reason: RejectionReason }).strict()).max(50),
  local_rejections: z.array(z.object({ file: z.string().regex(/^\d{4}-\d{2}-\d{2}\.jsonl$/), line: z.number().int().positive(), reason: RejectionReason }).strict()).max(50),
}).strict();
const Ledger = z.object({ schema_version: z.literal(1), truncated: z.number().int().nonnegative(), records: z.array(Receipt).max(100) }).strict();
export type UploadReceipt = z.infer<typeof Receipt>;
export const UPLOAD_RECEIPTS = "project-dev-agent/telemetry/upload-receipts.json";

/** 在上传锁内先原子保存拒绝/降级证据，再推进游标；仅存索引与固定码，绝不复制被拒正文。 */
export async function saveUploadReceipt(files: ProjectFiles, input: UploadReceipt) {
  const receipt = Receipt.parse(input); let previous: string | undefined;
  try { previous = await files.read(UPLOAD_RECEIPTS, 65_536); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const prior = previous ? Ledger.parse(JSON.parse(previous)) : { schema_version: 1 as const, truncated: 0, records: [] };
  const comparable = ({ at: _at, ...value }: UploadReceipt) => JSON.stringify(value);
  if (prior.records.some(item => comparable(item) === comparable(receipt))) return;
  const records = [...prior.records.filter(item => Date.parse(item.at) >= Date.now() - 30 * 86_400_000), receipt];
  let truncated = prior.truncated, raw = "";
  for (;;) {
    raw = JSON.stringify({ schema_version: 1, truncated, records });
    if (records.length <= 100 && Buffer.byteLength(raw) <= 60_000) break;
    records.shift(); truncated++;
  }
  if (previous === undefined) await files.create(UPLOAD_RECEIPTS, raw); else await files.replace(UPLOAD_RECEIPTS, raw, previous);
}

/** 与上传共用锁清理30天以外的摘要；忙碌时留待下一次，不覆盖正在保存的新回执。 */
export async function pruneUploadReceipts(files: ProjectFiles) {
  let previous: string;
  try { previous = await files.read(UPLOAD_RECEIPTS, 65_536); } catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  const release = await acquireFileLock(files, "project-dev-agent/telemetry/upload.lock", "UPLOAD_BUSY").catch(error => {
    if (hasCode(error, "UPLOAD_BUSY")) return undefined; throw error;
  });
  if (!release) return;
  try {
    previous = await files.read(UPLOAD_RECEIPTS, 65_536);
    const ledger = Ledger.parse(JSON.parse(previous)), records = ledger.records.filter(item => Date.parse(item.at) >= Date.now() - 30 * 86_400_000);
    if (records.length !== ledger.records.length) await files.replace(UPLOAD_RECEIPTS, JSON.stringify({ ...ledger, records }), previous);
  } finally { await release(); }
}
