import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import { HASH } from "../understanding/fields.js";
import { ObjectEnvelopeSchema, type ObjectEnvelope } from "./contracts.js";
import { SourceStampSchema, type SourceStamp } from "./source-stamp.js";

const FingerprintSchema = z.object({ path: z.string().min(1), sha256: HASH.nullable() }).strict();
const BasisSchema = z.enum(["observed", "intended", "inferred"]);

/** 项目库中模块快照的最小外壳；业务模型正文仍由 understanding 的 v2 内容负责。 */
export const ModuleSnapshotSchema = z.object({
  model_id: z.string().min(1).max(200), module: z.string().min(1).max(200),
  parent_snapshot_ids: z.array(HASH).max(20), basis: BasisSchema,
  source_fingerprints: z.array(FingerprintSchema).max(5_000),
  dependency_fingerprints: z.array(FingerprintSchema).max(1_000),
  configuration_fingerprints: z.array(FingerprintSchema).max(200),
  content: z.unknown(),
}).strict();
export type ModuleSnapshot = z.infer<typeof ModuleSnapshotSchema>;

export const ViewModuleSchema = z.object({
  model_id: z.string().min(1), state: z.enum(["matched", "needs_review", "ambiguous", "partial"]),
  selected_snapshot_id: HASH.optional(), candidate_snapshot_ids: z.array(HASH).max(100), reasons: z.array(z.string().max(200)).max(20),
}).strict();
export type ViewModule = z.infer<typeof ViewModuleSchema>;

export const KnowledgeViewSchema = z.object({
  schema_version: z.literal(1), view_token: HASH, source_stamp_id: HASH,
  selected_snapshot_ids: z.array(HASH).max(10_000), modules: z.array(ViewModuleSchema).max(10_000),
  unresolved: z.array(z.string().max(200)).max(10_000), readset: z.object({ source_stamp_id: HASH, snapshot_ids: z.array(HASH).max(10_000) }).strict(),
}).strict();
export type KnowledgeView = z.infer<typeof KnowledgeViewSchema>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function mapFingerprint(values: Array<{ path: string; sha256: string | null }>): Map<string, string | null> {
  return new Map(values.map((value) => [value.path, value.sha256]));
}

function compareFingerprints(expected: Array<{ path: string; sha256: string | null }>, current: Map<string, string | null>): string[] {
  const reasons: string[] = [];
  for (const item of expected) {
    if (!current.has(item.path)) reasons.push(`source_missing:${item.path}`);
    else if (current.get(item.path) !== item.sha256) reasons.push(`source_changed:${item.path}`);
  }
  return reasons;
}

function evidenceKeys(snapshot: ModuleSnapshot): Set<string> {
  return new Set([
    ...snapshot.source_fingerprints.map((item) => `source:${item.path}:${item.sha256 ?? "null"}`),
    ...snapshot.dependency_fingerprints.map((item) => `dependency:${item.path}:${item.sha256 ?? "null"}`),
    ...snapshot.configuration_fingerprints.map((item) => `config:${item.path}:${item.sha256 ?? "null"}`),
  ]);
}

function dominates(a: { id: string; value: ModuleSnapshot }, b: { id: string; value: ModuleSnapshot }): boolean {
  if (a.value.parent_snapshot_ids.includes(b.id)) return true;
  const aKeys = evidenceKeys(a.value), bKeys = evidenceKeys(b.value);
  return aKeys.size > bKeys.size && [...bKeys].every((key) => aKeys.has(key));
}

function parseSnapshots(objects: ObjectEnvelope[]): Array<{ id: string; value: ModuleSnapshot }> {
  return objects.filter((object) => object.object_type === "module_snapshot").map((object) => {
    try { return { id: object.object_id, value: ModuleSnapshotSchema.parse(object.content) }; }
    catch { throw new AppError("PROJECT_KNOWLEDGE_SNAPSHOT_CORRUPT", `模块快照内容无效：${object.object_id}`); }
  });
}

/**
 * 只根据当前源码指纹选择适用快照；不按写入时间、分支名或对象数组顺序裁决。
 * 同一模块的组合快照需要由上层在实际整合代码核验后写入，并通过 parent_snapshot_ids 追溯来源。
 */
export function resolveKnowledgeView(input: { source_stamp: SourceStamp; snapshots: ObjectEnvelope[] }): KnowledgeView {
  const source_stamp = SourceStampSchema.parse(input.source_stamp);
  const candidates = parseSnapshots(input.snapshots);
  const byModel = new Map<string, Array<{ id: string; value: ModuleSnapshot }>>();
  for (const candidate of candidates) {
    const list = byModel.get(candidate.value.model_id) ?? [];
    list.push(candidate); byModel.set(candidate.value.model_id, list);
  }
  const sources = mapFingerprint(source_stamp.entries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })));
  const configuration = mapFingerprint(source_stamp.configuration);
  const modules: ViewModule[] = [];
  const selected_snapshot_ids: string[] = [];
  const unresolved: string[] = [];
  for (const [model_id, values] of [...byModel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const evaluated = values.map((candidate) => {
      const reasons = [
        ...compareFingerprints(candidate.value.source_fingerprints, sources),
        ...compareFingerprints(candidate.value.dependency_fingerprints, sources),
        ...compareFingerprints(candidate.value.configuration_fingerprints, configuration),
      ];
      if (candidate.value.source_fingerprints.length === 0) reasons.push("source_evidence_missing");
      return { ...candidate, reasons };
    });
    const exact = evaluated.filter((candidate) => candidate.reasons.length === 0);
    let state: ViewModule["state"], selected: string | undefined, reasons: string[];
    if (exact.length === 1) {
      state = source_stamp.coverage.complete ? "matched" : "partial";
      selected = exact[0]!.id; reasons = source_stamp.coverage.complete ? [] : ["source_coverage_incomplete"];
    } else if (exact.length > 1) {
      const undominated = exact.filter((candidate) => !exact.some((other) => other.id !== candidate.id && dominates(other, candidate)));
      if (undominated.length === 1) {
        state = source_stamp.coverage.complete ? "matched" : "partial"; selected = undominated[0]!.id;
        reasons = source_stamp.coverage.complete ? [] : ["source_coverage_incomplete"];
      } else {
        state = source_stamp.coverage.complete ? "ambiguous" : "partial";
        reasons = [source_stamp.coverage.complete ? "multiple_exact_snapshots" : "source_coverage_incomplete"];
      }
    } else {
      state = source_stamp.coverage.complete ? (values.length > 1 ? "ambiguous" : "needs_review") : "partial";
      reasons = [...new Set(evaluated.flatMap((candidate) => candidate.reasons).slice(0, 20))];
      if (!reasons.length) reasons = ["no_matching_snapshot"];
    }
    if (selected) selected_snapshot_ids.push(selected);
    if (state !== "matched") unresolved.push(`${model_id}:${state}`);
    modules.push(ViewModuleSchema.parse({ model_id, state, ...(selected ? { selected_snapshot_id: selected } : {}), candidate_snapshot_ids: values.map((item) => item.id), reasons }));
  }
  const readset = { source_stamp_id: source_stamp.stamp_id, snapshot_ids: [...selected_snapshot_ids].sort() };
  const view_token = digest(JSON.stringify({ schema_version: 1, source_stamp_id: source_stamp.stamp_id, modules, unresolved, readset }));
  return KnowledgeViewSchema.parse({ schema_version: 1, view_token, source_stamp_id: source_stamp.stamp_id, selected_snapshot_ids, modules, unresolved, readset });
}

