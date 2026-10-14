import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { AppError } from "../domain/error.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { AnalysisSchema, BatchSchema, HISTORY_DIR, ManifestSchema, type HistoryFinding, type HistoryManifest, type HistoryMessage } from "./contracts.js";

export interface HistoryHint extends Omit<HistoryFinding, "evidence"> {
  id: string; effective: false; status: "candidate"; evidence: (HistoryFinding["evidence"][number] & { source: HistoryMessage })[];
  session_count: number; potential_conflicts: string[];
  first_seen: string | null; last_seen: string | null;
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
  if (manifest.project !== files.root) throw new AppError("HISTORY_PROJECT_MISMATCH", "History belongs to another project");
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
      if (!dead || attempt > 0) throw new AppError("HISTORY_BUSY", "Another history operation is active or its lock needs inspection");
      if (await optional(files, path) !== prior) throw new AppError("HISTORY_BUSY", "History lock changed");
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
    if (analysis.batch_id !== id || batch.id !== id || batch.project !== files.root) throw new AppError("HISTORY_RECORD_MISMATCH", "History batch identity mismatch");
    analyzed++;
    for (const finding of analysis.findings) {
      const evidence = finding.evidence.map((entry) => {
        const source = batch.messages.find((message) => message.id === entry.message_id);
        if (!source || source.role !== "user" || !source.text.includes(entry.quote)) throw new AppError("HISTORY_EVIDENCE_INVALID", "Saved history evidence no longer matches a user message");
        return { ...entry, source };
      });
      const key = findingId(finding);
      const prior = combined.get(key);
      if (prior) {
        for (const item of evidence) if (!prior.evidence.some((old) => old.message_id === item.message_id && old.quote === item.quote)) prior.evidence.push(item);
      } else combined.set(key, { ...finding, id: key, effective: false, status: "candidate", evidence, session_count: 0, potential_conflicts: [], first_seen: null, last_seen: null });
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

export async function historyStatus(files: ProjectFiles) {
  const profile = await historyProfile(files);
  return { state: !profile.manifest ? "not_scanned" : profile.pending.length ? "analysis_pending" : profile.manifest.coverage.source_complete ? "analyzed" : "partial",
    scan_id: profile.manifest?.scan_id ?? null, total_batches: profile.manifest?.batches.length ?? 0,
    analyzed_batches: profile.analyzed, pending_batches: profile.pending.length, candidate_count: profile.hints.length,
    report: profile.manifest ? `${HISTORY_DIR}/report.html` : null,
    next_step: !profile.manifest ? "Run history_scan for first-use project history discovery."
      : profile.pending.length ? "Read history_next and save semantic findings with history_record until all batches are analyzed."
      : "History candidates are review hints, not confirmed team policy. Scan again to discover newly saved conversations." };
}
