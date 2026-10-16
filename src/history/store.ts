import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { AppError } from "../domain/error.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { AnalysisSchema, BatchSchema, HISTORY_DIR, HistoryControlSchema, ManifestSchema, type HistoryFinding, type HistoryManifest, type HistoryMessage } from "./contracts.js";

export interface HistoryHint extends Omit<HistoryFinding, "evidence"> {
  id: string; effective: false; status: "candidate"; evidence: (HistoryFinding["evidence"][number] & { source: HistoryMessage })[];
  session_count: number; potential_conflicts: string[];
  first_seen: string | null; last_seen: string | null;
  analysis_refs: { batch_id: string; revision: number }[];
}
export async function optional(files: ProjectFiles, path: string): Promise<string | undefined> {
  try { return await files.read(path, 65_536); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}
export async function save(files: ProjectFiles, path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value)}\n`, before = await optional(files, path);
  if (before === content) return;
  if (before === undefined) await files.create(path, content); else await files.replace(path, content, before);
}
export async function manifestFor(files: ProjectFiles): Promise<HistoryManifest | undefined> {
  const raw = await optional(files, `${HISTORY_DIR}/manifest.json`);
  if (!raw) return undefined;
  const manifest = ManifestSchema.parse(JSON.parse(raw));
  if (manifest.project !== files.root) throw new AppError("HISTORY_PROJECT_MISMATCH", "历史记录属于另一个项目");
  return manifest;
}

export async function withHistoryLock<T>(files: ProjectFiles, action: () => Promise<T>): Promise<T> {
  const path = `${HISTORY_DIR}/operation.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let attempt = 0; ; attempt++) {
    try { await files.create(path, owner); break; } catch (error) {
      if (!(error instanceof AppError && error.code === "FILE_EXISTS")) throw error;
      const prior = await optional(files, path);
      let dead = false;
      try {
        const pid: unknown = JSON.parse(prior ?? "{}").pid;
        if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { if (hasCode(probe, "ESRCH")) dead = true; }
        }
      } catch { /* Unknown owners require manual reconciliation. */ }
      if (!dead || attempt > 0) throw new AppError("HISTORY_BUSY", "其他历史分析操作正在运行，或其锁文件需要检查");
      if (await optional(files, path) !== prior) throw new AppError("HISTORY_BUSY", "历史记录的锁文件已变化");
      await unlink(await files.path(path));
    }
  }
  try { return await action(); } finally {
    if (await optional(files, path) === owner) await unlink(await files.path(path));
  }
}

function normalized(text: string): string { return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, ""); }
export function findingId(finding: HistoryFinding): string {
  return `habit-${digest(JSON.stringify([finding.type, finding.audience, normalized(finding.rule), [...finding.paths].sort(), finding.applicable_conditions.map(normalized).sort()])).slice(0, 24)}`;
}
export async function historyProfile(files: ProjectFiles) {
  const manifest = await manifestFor(files);
  if (!manifest) return { manifest: undefined, analyzed: 0, pending: [] as string[], hints: [] as HistoryHint[] };
  const pending: string[] = [], combined = new Map<string, HistoryHint>();
  let analyzed = 0;
  for (const id of manifest.batches) {
    const raw = await optional(files, `${HISTORY_DIR}/analysis/${id}.json`);
    if (!raw) { pending.push(id); continue; }
    const analysis = AnalysisSchema.parse(JSON.parse(raw));
    const batch = BatchSchema.parse(JSON.parse(await files.read(`${HISTORY_DIR}/batches/${id}.json`, 65_536)));
    if (analysis.batch_id !== id || batch.id !== id || batch.project !== files.root) throw new AppError("HISTORY_RECORD_MISMATCH", "历史批次的身份信息不匹配");
    analyzed++;
    for (const finding of analysis.findings) {
      const evidence = finding.evidence.map((entry) => {
        const source = batch.messages.find((message) => message.id === entry.message_id);
        if (!source || source.role !== "user" || !source.text.includes(entry.quote)) throw new AppError("HISTORY_EVIDENCE_INVALID", "已保存的历史证据与用户消息不再匹配");
        return { ...entry, source };
      });
      const key = findingId(finding);
      const prior = combined.get(key);
      if (prior) {
        for (const item of evidence) if (!prior.evidence.some((old) => old.message_id === item.message_id && old.quote === item.quote)) prior.evidence.push(item);
        if (!prior.analysis_refs.some((entry) => entry.batch_id === id)) prior.analysis_refs.push({ batch_id: id, revision: analysis.revision });
      } else combined.set(key, { ...finding, id: key, effective: false, status: "candidate", evidence, session_count: 0, potential_conflicts: [], first_seen: null, last_seen: null,
        analysis_refs: [{ batch_id: id, revision: analysis.revision }] });
    }
  }
  const hints = [...combined.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const hint of hints) {
    hint.evidence.sort((a, b) => (Date.parse(b.source.timestamp) || 0) - (Date.parse(a.source.timestamp) || 0)
      || (a.source.session === b.source.session ? b.source.line - a.source.line : a.source.session.localeCompare(b.source.session)));
    const dates = hint.evidence.map(({ source }) => Date.parse(source.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
    hint.first_seen = dates.length ? new Date(dates[0]!).toISOString() : null;
    hint.last_seen = dates.length ? new Date(dates[dates.length - 1]!).toISOString() : null;
    hint.session_count = new Set(hint.evidence.map((entry) => entry.source.session)).size;
    hint.potential_conflicts = hints.filter((other) => other.id !== hint.id && other.audience === hint.audience
      && normalized(other.topic) === normalized(hint.topic) && normalized(other.rule) !== normalized(hint.rule)).map((other) => other.id);
  }
  hints.sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? "") || a.id.localeCompare(b.id));
  return { manifest, analyzed, pending, hints };
}

export async function historyControl(files: ProjectFiles) {
  const raw = await optional(files, `${HISTORY_DIR}/control.json`);
  return raw ? HistoryControlSchema.parse(JSON.parse(raw)) : { paused: false, pause_reason: "user" as const, updated_at: "" };
}

export async function historyStatus(files: ProjectFiles) {
  const profile = await historyProfile(files);
  const control = await historyControl(files);
  return { state: !profile.manifest ? "not_scanned" : profile.pending.length ? control.paused ? "paused" : "analysis_pending" : profile.manifest.coverage.source_complete ? "analyzed" : "partial",
    scan_id: profile.manifest?.scan_id ?? null, total_batches: profile.manifest?.batches.length ?? 0,
    analyzed_batches: profile.analyzed, pending_batches: profile.pending.length, candidate_count: profile.hints.length,
    paused: control.paused, pause_reason: control.paused ? control.pause_reason : null,
    analysis_complete: !!profile.manifest && profile.pending.length === 0,
    report: profile.manifest ? `${HISTORY_DIR}/report.html` : null,
    next_step: !profile.manifest ? "首次使用时，请运行 history_scan 发现项目历史对话。"
      : profile.pending.length ? control.paused ? "历史分析已暂停，仍有待处理批次。调用 history_next 并传 action: resume 后从断点继续；当前需求可依据现有资料开发。"
        : "请读取 history_next，并通过 history_record 保存当前批次。日常开发可分轮完成全量分析；需要暂停时调用 history_next 并传 action: pause，准确说明剩余批次。"
      : "历史候选供审查参考，尚未确认为团队规则。重新扫描可发现新保存的对话。" };
}
