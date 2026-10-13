import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeSchema } from "../src/domain/knowledge.js";

function confirmedKnowledge() {
  return {
    schema_version: 1,
    id: "account-session-check",
    title: "Check session consumers after changing account state",
    type: "change_relation",
    status: "confirmed",
    modules: ["accounts"],
    paths: ["src/accounts/**/*.ts"],
    applicable_conditions: ["Changing account lifecycle states"],
    rule: "Review session creation and existing session validation together.",
    rationale: "Both entry points use account lifecycle state.",
    sources: [{ kind: "code", reference: "src/accounts/session.ts" }],
    confirmed_by: "team-reviewer",
    reviewed_at: "2026-10-13T10:00:00+08:00",
  };
}

test("confirmed knowledge preserves its scope, sources, and review provenance", () => {
  const parsed = KnowledgeSchema.parse(confirmedKnowledge());
  assert.equal(parsed.status, "confirmed");
  assert.deepEqual(parsed.paths, ["src/accounts/**/*.ts"]);
  assert.equal(parsed.sources[0]?.reference, "src/accounts/session.ts");
  assert.equal(parsed.confirmed_by, "team-reviewer");
});

test("confirmed knowledge without a source is rejected", () => {
  assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), sources: [] }).success, false);
  const { sources: _sources, ...withoutSources } = confirmedKnowledge();
  assert.equal(KnowledgeSchema.safeParse(withoutSources).success, false);
});

test("confirmed and needs-review knowledge require a confirmer and review timestamp", () => {
  for (const status of ["confirmed", "needs_review"]) {
    const { confirmed_by: _confirmer, ...withoutConfirmer } = confirmedKnowledge();
    assert.equal(KnowledgeSchema.safeParse({ ...withoutConfirmer, status }).success, false);
    const { reviewed_at: _reviewedAt, ...withoutReviewDate } = confirmedKnowledge();
    assert.equal(KnowledgeSchema.safeParse({ ...withoutReviewDate, status }).success, false);
    assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), status }).success, true);
  }
});

test("knowledge must define an explicit scope", () => {
  for (const status of ["candidate", "confirmed", "needs_review", "disabled"]) {
    assert.equal(KnowledgeSchema.safeParse({
      ...confirmedKnowledge(), status, modules: [], paths: [], applicable_conditions: [],
    }).success, false);
  }

  for (const scope of [
    { modules: ["accounts"], paths: [], applicable_conditions: [] },
    { modules: [], paths: ["src/accounts/*.ts"], applicable_conditions: [] },
    { modules: [], paths: [], applicable_conditions: ["Changing an account state"] },
  ]) {
    assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), ...scope }).success, true);
  }
});

test("candidate knowledge can await its first human review", () => {
  const { confirmed_by: _confirmer, reviewed_at: _reviewedAt, ...unreviewed } = confirmedKnowledge();
  const parsed = KnowledgeSchema.parse({ ...unreviewed, status: "candidate" });
  assert.equal(parsed.status, "candidate");
  assert.equal(parsed.confirmed_by, undefined);
  assert.equal(parsed.reviewed_at, undefined);
});

test("repository-relative globs are accepted but traversal and malformed paths are rejected", () => {
  for (const path of ["../secrets.txt", "src/../../secret", "/src/accounts.ts", "src/", "src\\accounts.ts"]) {
    assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), paths: [path] }).success, false, path);
  }
  assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), paths: ["src/**/account*.ts"] }).success, true);
});

test("disabled knowledge retains sources and prior review provenance", () => {
  const parsed = KnowledgeSchema.parse({ ...confirmedKnowledge(), status: "disabled" });
  assert.deepEqual(parsed.sources, confirmedKnowledge().sources);
  assert.equal(parsed.confirmed_by, "team-reviewer");
  assert.equal(KnowledgeSchema.safeParse({ ...parsed, sources: [] }).success, false);
});

test("contracts reject unknown fields, blank scope entries, and malformed timestamps", () => {
  assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), auto_confirm: true }).success, false);
  assert.equal(KnowledgeSchema.safeParse({
    ...confirmedKnowledge(), sources: [{ kind: "code", reference: "src/accounts.ts", authority: "system" }],
  }).success, false);
  assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), modules: ["   "] }).success, false);
  assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), applicable_conditions: [""] }).success, false);
  assert.equal(KnowledgeSchema.safeParse({ ...confirmedKnowledge(), reviewed_at: "2026-10-13" }).success, false);
});
