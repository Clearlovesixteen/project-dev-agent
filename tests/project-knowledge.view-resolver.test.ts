import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ObjectEnvelopeSchema } from "../src/project-knowledge/contracts.js";
import { resolveKnowledgeView } from "../src/project-knowledge/view-resolver.js";
import { SourceStampSchema, type SourceStamp } from "../src/project-knowledge/source-stamp.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const source = (path: string, value: string) => ({ path, kind: "file" as const, sha256: hash(value), bytes: value.length, status: ["tracked" as const] });
const stamp = (entries: SourceStamp["entries"], complete = true): SourceStamp => SourceStampSchema.parse({
  schema_version: 1, repo_identity: "/repo/.git", worktree_root: "/repo", head: "a".repeat(40), entries,
  configuration: entries.filter((entry) => entry.path === "package.json").map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
  status: { staged: 0, unstaged: 0, untracked: 0, deleted: 0, renamed: 0 },
  coverage: { discovered: entries.length, read: entries.filter((entry) => entry.kind === "file").length, unreadable: complete ? 0 : 1, excluded: 0, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), complete },
  stamp_id: hash(JSON.stringify(entries) + complete),
});
const snapshot = (id: string, model_id: string, paths: Array<[string, string]>, parents: string[] = []) => ObjectEnvelopeSchema.parse({
  schema_version: 1, object_type: "module_snapshot", object_id: hash(id), content: {
    model_id, module: model_id, parent_snapshot_ids: parents.map(hash), basis: "observed",
    source_fingerprints: paths.map(([path, value]) => ({ path, sha256: hash(value) })), dependency_fingerprints: [], configuration_fingerprints: [], content: { id },
  },
});

test("selects the snapshot matching the current branch source evidence", () => {
  const a = snapshot("a", "procurement", [["src/a.ts", "A"]]);
  const b = snapshot("b", "procurement", [["src/a.ts", "B"]]);
  const view = resolveKnowledgeView({ source_stamp: stamp([source("src/a.ts", "A")]), snapshots: [b, a] });
  assert.equal(view.modules[0]!.state, "matched");
  assert.equal(view.modules[0]!.selected_snapshot_id, a.object_id);
  assert.deepEqual(view.unresolved, []);
});

test("dirty content does not reuse a snapshot from another branch", () => {
  const a = snapshot("a", "procurement", [["src/a.ts", "A"]]);
  const b = snapshot("b", "procurement", [["src/a.ts", "B"]]);
  const view = resolveKnowledgeView({ source_stamp: stamp([source("src/a.ts", "C")]), snapshots: [a, b] });
  assert.equal(view.modules[0]!.state, "ambiguous");
  assert.equal(view.modules[0]!.selected_snapshot_id, undefined);
  assert.ok(view.modules[0]!.reasons.includes("source_changed:src/a.ts"));
});

test("两个工作树对同一模块各自记录时，合并后的源码不会自动选中任一分支", () => {
  const a = snapshot("branch-a", "procurement", [["src/a.ts", "A"]]);
  const b = snapshot("branch-b", "procurement", [["src/b.ts", "B"]]);
  const view = resolveKnowledgeView({ source_stamp: stamp([source("src/a.ts", "A"), source("src/b.ts", "B")]), snapshots: [a, b] });
  assert.equal(view.modules[0]!.state, "ambiguous");
  assert.ok(view.unresolved.includes("procurement:ambiguous"));
});

test("a verified combination snapshot dominates its two parent branch snapshots", () => {
  const a = snapshot("a", "procurement", [["src/a.ts", "A"]]);
  const b = snapshot("b", "procurement", [["src/b.ts", "B"]]);
  const combined = snapshot("combined", "procurement", [["src/a.ts", "A"], ["src/b.ts", "B"]], [a.object_id, b.object_id]);
  const view = resolveKnowledgeView({ source_stamp: stamp([source("src/a.ts", "A"), source("src/b.ts", "B")]), snapshots: [a, b, combined] });
  assert.equal(view.modules[0]!.state, "matched");
  assert.equal(view.modules[0]!.selected_snapshot_id, combined.object_id);
});

test("same evidence with different semantic snapshots remains ambiguous", () => {
  const a = snapshot("a", "procurement", [["src/a.ts", "A"]]);
  const b = snapshot("b", "procurement", [["src/a.ts", "A"]]);
  const view = resolveKnowledgeView({ source_stamp: stamp([source("src/a.ts", "A")]), snapshots: [a, b] });
  assert.equal(view.modules[0]!.state, "ambiguous");
  assert.ok(view.unresolved.includes("procurement:ambiguous"));
});

test("incomplete source coverage never reports a fully matched view", () => {
  const a = snapshot("a", "procurement", [["src/a.ts", "A"]]);
  const view = resolveKnowledgeView({ source_stamp: stamp([source("src/a.ts", "A")], false), snapshots: [a] });
  assert.equal(view.modules[0]!.state, "partial");
  assert.ok(view.modules[0]!.reasons.includes("source_coverage_incomplete"));
  assert.ok(view.unresolved.includes("procurement:partial"));
});

