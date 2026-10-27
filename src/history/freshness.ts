import { homedir } from "node:os";
import { join } from "node:path";
import { digest } from "../knowledge/document.js";
import { ProjectFiles } from "../storage/project-files.js";
import {
  belongsToProject,
  discoverSessions,
  historyHome,
  sessionMeta,
} from "./codex-reader.js";
import { manifestFor } from "./store.js";
/** 只探测本项目来源元数据，不把旧快照的已完成状态当成新增对话已经分析。 */
export async function historyFreshness(
  files: ProjectFiles,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
) {
  const manifest = await manifestFor(files);
  if (!manifest) return { state: "not_scanned", needs_refresh: true };
  const home = await historyHome(codexHome),
    inventory = await discoverSessions(home),
    selected = new Map<string, (typeof inventory.files)[number]>();
  let partial = inventory.diagnostics.length > 0;
  for (const file of inventory.files) {
    try {
      const meta = await sessionMeta(file);
      if (!meta.internal && (await belongsToProject(meta.cwd, files.root))) {
        const previous = selected.get(meta.id);
        if (
          !previous ||
          file.size > previous.size ||
          (file.size === previous.size && file.mtime > previous.mtime)
        )
          selected.set(meta.id, file);
      }
    } catch {
      partial = true;
    }
  }
  const cursor = digest(
    JSON.stringify(
      [...selected]
        .map(([id, file]) => [id, file.relative, file.size, file.mtime])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
  return {
    state: partial
      ? "partial"
      : manifest.source_home !== home || manifest.source_cursor !== cursor
      ? "changed"
      : "current",
    needs_refresh:
      partial ||
      manifest.source_home !== home ||
      manifest.source_cursor !== cursor,
    cursor,
    scanned_at: manifest.scanned_at,
    limitation: "仅核对来源变动；发现新消息不代表已经完成语义分析。",
  };
}
