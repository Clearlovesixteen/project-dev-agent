import { createHash } from "node:crypto";
import type { ProjectConfig } from "../knowledge/config.js";
import { excluded } from "../understanding/scan.js";
import { sourceFingerprint } from "../understanding/model-evidence.js";
import type { SavedModel } from "../understanding/model-contracts.js";
import { worktreeModel } from "./model-visibility.js";
import type { SourceStamp } from "./source-stamp.js";
import type { ModuleSnapshot, ViewModule } from "./view-resolver.js";

/** 复核项是当前工作树的派生视图；不修改规则、任务及旧工作树的状态。 */
interface RuleReview {
  review_id: string;
  model_id: string;
  rule_id: string;
  kind: "source" | "specification" | "binding" | "test" | "relation" | "configuration" | "evidence_revision";
  fingerprint_kind: "file" | "source_record";
  change: "modified" | "added" | "missing_or_moved" | "rename_unresolved" | "unreadable";
  symbols?: string[];
  path: string;
  previous_sha256: string | null;
  current_sha256: string | null;
  scenario_ids: string[];
}
export interface RuleReviews { items: RuleReview[]; omitted: number }
type Target = Pick<RuleReview, "rule_id" | "kind" | "scenario_ids" | "symbols">;

/** 同一个来源可供多条规则使用，测试绑定优先显示它实际保护的规则和场景。 */
function targetsByPath(model: Exclude<SavedModel, {schema_version: 1}>) {
  const paths = new Map<string, Map<string, Target>>(), all: Target[] = [];
  const revised: { path: string; previous: string; current: string; target: Target }[] = [];
  const sources = new Map(model.sources.map(source => [source.id, source]));
  function attach(path: string, target: Target) {
    const matches = paths.get(path) ?? new Map<string, Target>();
    matches.set(target.rule_id, target); paths.set(path, matches);
  }
  for (const rule of model.rules) {
    const semantics = "semantics" in rule ? rule.semantics : undefined;
    const scenario_ids = semantics ? [...semantics.cases.map(item => 'case/' + item.id), ...semantics.preserves.map(item => 'preserve/' + item.id)].sort() : [];
    const target = { rule_id: rule.id, scenario_ids };
    all.push({ ...target, kind: "configuration" });
    for (const id of rule.source_ids) {
      const source = sources.get(id);
      if (source && "path" in source) {
        attach(source.path, { ...target, kind: source.kind === "document" ? "specification" : "source" });
        // 相同源码文件被另一个规则复核后，原规则仍可能引用旧定位或引文。
        const previous = rule.evidence_versions.find(version => version.id === id)?.fingerprint, current = sourceFingerprint(source);
        if (previous && previous !== current) revised.push({ path: source.path, previous, current, target: { ...target, kind: "evidence_revision" } });
      }
    }
    for (const relation of model.relations.filter(item => item.rule_ids.includes(rule.id))) {
      attach(relation.target_path, { ...target, kind: "relation" });
      for (const id of relation.source_ids) {
        const source = sources.get(id);
        if (source && "path" in source && !paths.get(source.path)?.has(rule.id)) attach(source.path, { ...target, kind: "relation" });
      }
    }
    for (const binding of "bindings" in rule ? rule.bindings ?? [] : []) {
      const existing = paths.get(binding.path)?.get(rule.id);
      const symbols = [...new Set([...(existing?.symbols ?? []), ...(binding.symbol ? [binding.symbol] : [])])].sort();
      attach(binding.path, { ...target, kind: binding.role === "test" || existing?.kind === "test" ? "test" : "binding", ...(symbols.length ? { symbols } : {}) });
    }
  }
  return { paths, all, revised };
}

// 缓存仅按不可变对象 ID；工作树、配置可见性和文件指纹在每次查询时重新判断。
const indexes = new Map<string, { paths: string[]; targets: ReturnType<typeof targetsByPath> }>();
function snapshotIndex(id: string, snapshot: ModuleSnapshot, root: string) {
  const hit = indexes.get(id);
  if (hit) return hit;
  const model = worktreeModel(root, snapshot.content, snapshot.model_id);
  if (!model || model.schema_version === 1) return undefined;
  const entry = { paths: [...new Set([...model.related_paths, ...model.sources.flatMap(item => "path" in item ? [item.path] : [])])], targets: targetsByPath(model) };
  if (indexes.size >= 64) indexes.delete(indexes.keys().next().value!);
  indexes.set(id, entry);
  return entry;
}

/** 完整匹配的模型也要核对条目内部挂的来源版本。未决模型只展开谱系末端，比较本次查询已经捕获的文件指纹，避免为复核项重扫磁盘。 */
export function ruleReviews(snapshots: Map<string, ModuleSnapshot>, modules: ViewModule[], stamp: SourceStamp, config: ProjectConfig, focusRules?: Set<string>, limit = 20): RuleReviews {
  const seen = new Set<string>(), focused: RuleReview[] = [], remainder: RuleReview[] = [];
  const entries = new Map(stamp.entries.map(entry => [entry.path, entry]));
  const configurations = new Map(stamp.configuration.map(entry => [entry.path, entry.sha256]));
  const superseded = new Set([...snapshots.values()].flatMap(snapshot => snapshot.parent_snapshot_ids));
  for (const module of modules) {
    const candidates = module.selected_snapshot_id ? [module.selected_snapshot_id] : module.candidate_snapshot_ids.filter(id => !superseded.has(id)).sort();
    for (const snapshotId of candidates) {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) continue;
      const saved = snapshotIndex(snapshotId, snapshot, stamp.worktree_root);
      if (!saved || saved.paths.some(path => excluded(path, config))) continue;
      const index = saved.targets;
      function compare(path: string, previous: string | null, current: string | null, targets: Iterable<Target>) {
        if (previous === current || excluded(path, config)) return;
        const entry = entries.get(path);
        const change = current === null ? (entry?.status.includes("renamed") ? "rename_unresolved" : entry?.kind === "unreadable" || entry?.kind === "symlink" ? "unreadable" : "missing_or_moved")
          : previous === null ? "added" : "modified";
        for (const target of targets) {
          const key = JSON.stringify([stamp.repo_identity, stamp.worktree_root, module.model_id, target.rule_id, target.kind, path, previous, current, change]);
          if (seen.has(key)) continue;
          seen.add(key);
          // 保留本任务规则的展示名额；无关模型的复核项不会挤掉与验收直接相关的线索。
          const items = focusRules?.has(module.model_id + "/" + target.rule_id) ? focused : remainder;
          if (items.length >= limit) continue;
          items.push({ ...target, change, fingerprint_kind: target.kind === "evidence_revision" ? "source_record" : "file", model_id: module.model_id, path, previous_sha256: previous, current_sha256: current,
            review_id: createHash("sha256").update(key).digest("hex") });
        }
      }
      for (const item of index.revised) compare(item.path, item.previous, item.current, [item.target]);
      if (module.state === "matched") continue;
      for (const source of [...snapshot.source_fingerprints, ...snapshot.dependency_fingerprints])
        compare(source.path, source.sha256, entries.get(source.path)?.sha256 ?? null, index.paths.get(source.path)?.values() ?? []);
      const previousConfig = new Map(snapshot.configuration_fingerprints.map(item => [item.path, item.sha256]));
      for (const path of new Set([...previousConfig.keys(), ...(snapshot.provenance ? configurations.keys() : [])]))
        compare(path, previousConfig.get(path) ?? null, configurations.get(path) ?? null, index.all);
    }
  }
  const items = [...focused, ...remainder].slice(0, limit);
  return { items, omitted: seen.size - items.length };
}
