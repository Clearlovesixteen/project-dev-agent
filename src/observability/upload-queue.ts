import { opendir } from "node:fs/promises";
import type { ProjectFiles } from "../storage/project-files.js";
import { hasCode } from "../storage/project-files.js";
import { DiagnosticEvent, type TelemetryEvent } from "./contracts.js";
import { EVENT_DIRECTORY } from "./writer.js";

export type UploadPositions = Record<string, number>;
export interface UploadPage { events: TelemetryEvent[]; positions: UploadPositions; }

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
  const pages: UploadPage[] = []; let batch: TelemetryEvent[] = [], invalid = 0;
  for (const name of names) {
    const lines = (await files.read(`${EVENT_DIRECTORY}/${name}`, 1_056_768)).split("\n");
    // 没有换行的尾部可能还在追加，不能消费或推进。
    for (let index = positions[name] ?? 0; index < lines.length - 1; index++) {
      positions[name] = index + 1;
      let event;
      try { event = DiagnosticEvent.safeParse(JSON.parse(lines[index]!)); } catch { invalid++; continue; }
      if (!event.success) { invalid++; continue; }
      if (event.data.upload_epoch !== epoch) continue;
      batch.push(event.data);
      if (batch.length === 50) {
        pages.push({ events: batch, positions: { ...positions } }); batch = [];
        if (pages.length === 4) return { pages, positions, invalid, pending: true };
      }
    }
  }
  if (batch.length) pages.push({ events: batch, positions: { ...positions } });
  return { pages, positions, invalid, pending: false };
}
