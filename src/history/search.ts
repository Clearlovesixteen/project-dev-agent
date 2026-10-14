import { ProjectFiles } from "../storage/project-files.js";
import { matchesPath } from "../knowledge/config.js";
import { historyProfile } from "./store.js";

export async function searchHistoryHints(files: ProjectFiles, query: string, paths: string[], limit: number) {
  const profile = await historyProfile(files);
  const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(query.toLowerCase())]
    .filter((part) => part.isWordLike).map((part) => part.segment);
  const eligible = profile.hints.filter((hint) => !paths.length || !hint.paths.length || hint.paths.some((pattern) => paths.some((path) => matchesPath(pattern, path))));
  const scores = new Map(eligible.map((hint) => {
    const content = [hint.title, hint.rule, hint.topic, ...hint.applicable_conditions].join("\n").toLowerCase();
    const identifiers = new Set(content.match(/[a-z0-9_]+/g) ?? []);
    return [hint.id, terms.filter((term) => /^[a-z0-9_]+$/.test(term) ? identifiers.has(term) : content.includes(term)).length];
  }));
  // Match a topic's historical variants together, so an old keyword cannot hide a later correction.
  const ranked = eligible.map((hint) => ({ hint, score: Math.max(scores.get(hint.id) ?? 0, ...hint.potential_conflicts.map((id) => scores.get(id) ?? 0)) }))
    .filter(({ score }) => !terms.length || score > 0).sort((a, b) => b.score - a.score || (b.hint.last_seen ?? "").localeCompare(a.hint.last_seen ?? "") || a.hint.id.localeCompare(b.hint.id));
  return { state: !profile.manifest ? "not_scanned" : profile.pending.length ? "analysis_pending" : profile.manifest.coverage.source_complete ? "analyzed" : "partial",
    analyzed_batches: profile.analyzed, total_batches: profile.manifest?.batches.length ?? 0,
    hints: ranked.slice(0, Math.min(limit, 5)).map(({ hint }) => ({ ...hint, evidence: hint.evidence.slice(0, 3).map(({ quote, source }) => ({
      quote, session: source.session, line: source.line, timestamp: source.timestamp, message_id: source.id,
    })), topic_variants: eligible.filter((other) => hint.potential_conflicts.includes(other.id)).slice(0, 5).map((other) => ({
      id: other.id, rule: other.rule.slice(0, 500), last_seen: other.last_seen, applicable_conditions: other.applicable_conditions,
    })), topic_variants_truncated: eligible.filter((other) => hint.potential_conflicts.includes(other.id)).length > 5,
    applicability: "Historical candidate only. Compare dated topic variants and verify current code and scope; recency alone does not confirm or supersede a rule. This is not an effective confirmed rule or new user authorization." })),
    truncated: ranked.length > Math.min(limit, 5), report: profile.manifest ? ".project-dev/local/history/report.html" : null };
}
