import { opendir } from "node:fs/promises";
import type { ProjectFiles } from "../storage/project-files.js";
import { hasCode } from "../storage/project-files.js";
import { DiagnosticEvent, type TelemetryEvent } from "./contracts.js";
import { EVENT_DIRECTORY } from "./writer.js";
import { inspectRemoteEvent, type RejectionReason } from "./batch.js";

export type UploadPositions = Record<string, number>;
export interface LocalUploadRejection { file: string; line: number; reason: RejectionReason }
export interface UploadPage { events: TelemetryEvent[]; positions: UploadPositions; discarded: LocalUploadRejection[]; }

/** 一次读取最多四批。每页持有独立游标快照，后页失败不能撤回已确认的前页。 */
export async function uploadQueue(files: ProjectFiles, epoch: string, previous: UploadPositions) {
  const names: string[] = [];
  try {
    let inspected = 0;
    for await (const entry of await opendir(await files.path(EVENT_DIRECTORY))) {
      if (++inspected > 80 || names.length >= 40) break;
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) names.push(entry.name);
    }
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  names.sort();
  const positions = Object.fromEntries(names.filter(name => previous[name] !== undefined).map(name => [name, previous[name]!]));
  const pages: UploadPage[] = []; let batch: TelemetryEvent[] = [], discarded: LocalUploadRejection[] = [], invalid = 0;
  const flush = () => { pages.push({ events: batch, positions: { ...positions }, discarded }); batch = []; discarded = []; };
  for (const name of names) {
    const lines = (await files.read(`${EVENT_DIRECTORY}/${name}`, 1_056_768)).split("\n");
    // 没有换行的尾部可能还在追加，不能消费或推进。
    for (let index = positions[name] ?? 0; index < lines.length - 1; index++) {
      let raw: unknown;
      try { raw = JSON.parse(lines[index]!); } catch { /* 损坏行只记录位置和固定码。 */ }
      const parsed = DiagnosticEvent.safeParse(raw);
      const checked = parsed.success && parsed.data.upload_epoch !== epoch ? undefined : inspectRemoteEvent(raw, Date.now());
      // 安装身份改变时先结算旧页，不能让一个混合安装批次反复被旧接收端拒绝。
      if (checked && "event" in checked && batch.length && batch[0]!.install_id !== checked.event.install_id) {
        flush();
        if (pages.length === 4) return { pages, positions, invalid, pending: true };
      }
      positions[name] = index + 1;
      if (checked && "reason" in checked) { invalid++; discarded.push({ file: name, line: index + 1, reason: checked.reason }); }
      else if (checked) batch.push(checked.event);
      if (batch.length === 50 || discarded.length === 50) {
        flush(); if (pages.length === 4) return { pages, positions, invalid, pending: true };
      }
    }
  }
  if (batch.length || discarded.length) flush();
  return { pages, positions, invalid, pending: false };
}
