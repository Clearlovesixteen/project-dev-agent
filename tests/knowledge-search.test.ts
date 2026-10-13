import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { KnowledgeSchema } from "../src/domain/knowledge.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { digest, renderKnowledge } from "../src/knowledge/document.js";
import { searchKnowledge } from "../src/knowledge/search.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-knowledge-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ProjectFiles(root);
  await files.create(".project-dev/project.yaml", "schema_version: 1\nmodules:\n  - name: accounts\n    paths: [src/accounts]\n  - name: invoices\n    paths: [src/invoices]\n");
  await files.directory(".project-dev/knowledge");
  await files.create("docs/policy.md", "Disabled accounts lose existing sessions.\n");
  const base = KnowledgeSchema.parse({ schema_version: 1, id: "sessions", title: "禁用账号与会话", type: "business_rule", status: "confirmed",
    modules: ["accounts"], paths: ["src/accounts/**/*.ts"], applicable_conditions: ["调整账号状态"],
    rule: "禁用账号后，已有会话必须失效。", rationale: "旧会话也会读取账号状态。",
    sources: [{ kind: "document", reference: "docs/policy.md", sha256: digest(await files.read("docs/policy.md")) }],
    confirmed_by: "fixture-reviewer", reviewed_at: "2026-10-13T00:00:00Z" });
  const add = async (overrides = {}, filename?: string) => {
    const knowledge = KnowledgeSchema.parse({ ...base, ...overrides });
    await files.create(`.project-dev/knowledge/${filename ?? knowledge.id}.md`, renderKnowledge(knowledge));
  };
  return { root, files, base, add };
}

function data(result: Awaited<ReturnType<typeof searchKnowledge>>) {
  return result.data as { results: { id: string; version: string; effective: boolean; status: string; source_status: { state: string }[] }[];
    notices: { id: string; status: string }[]; truncated: boolean; eligible_count: number };
}

test("Chinese keyword retrieval and affected paths return scoped knowledge with traceable versions", async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.add({ id: "invoice-sessions", modules: ["invoices"], paths: ["src/invoices/**/*.ts"] });
  const result = await searchKnowledge(f.files, { query: "禁用账号", modules: ["accounts"], paths: ["src/accounts/session.ts"] });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(data(result).results.map((entry) => entry.id), ["sessions"]);
  assert.match(data(result).results[0]!.version, /^[a-f0-9]{64}$/);
  assert.equal(data(result).results[0]!.effective, true);
  assert.equal(data(await searchKnowledge(f.files, { paths: ["src/accounts/nested/session.ts"] })).results.length, 1);
  assert.equal(data(await searchKnowledge(f.files, { paths: ["src/accounts-other/session.ts"] })).results.length, 0);
});

test("candidate and stale rules remain explicit hints while disabled rules cannot become constraints", async (t) => {
  const f = await fixture(t);
  await f.add({ status: "candidate", id: "draft" });
  await f.add({ status: "disabled", id: "retired" });
  await f.add({ status: "needs_review", id: "review" });
  const standard = data(await searchKnowledge(f.files, { modules: ["accounts"] }));
  assert.equal(standard.results.length, 0);
  assert.deepEqual(standard.notices.map((entry) => entry.id).sort(), ["draft", "review"]);
  const hints = data(await searchKnowledge(f.files, { modules: ["accounts"], include_unconfirmed: true }));
  assert.ok(hints.results.every((entry) => !entry.effective));
  assert.equal(hints.results.length, 2);
});

test("changed, missing and untracked sources require review without disabling unrelated knowledge", async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.add({ id: "untracked", sources: [{ kind: "document", reference: "docs/policy.md" }] });
  await f.add({ id: "missing", sources: [{ kind: "code", reference: "missing.ts", sha256: "a".repeat(64) }] });
  await f.add({ id: "experience", sources: [{ kind: "experience", reference: "review:123", description: "Fixture colleague's confirmed experience" }] });
  await writeFile(join(f.root, "docs/policy.md"), "The policy has been revised.\n");
  const result = data(await searchKnowledge(f.files, { modules: ["accounts"], include_unconfirmed: true }));
  assert.deepEqual(result.results.filter((entry) => entry.effective).map((entry) => entry.id), ["experience"]);
  assert.equal(result.results.find((entry) => entry.id === "sessions")?.source_status[0]?.state, "changed");
  assert.equal(result.results.find((entry) => entry.id === "missing")?.source_status[0]?.state, "missing");
  assert.equal(result.results.find((entry) => entry.id === "untracked")?.source_status[0]?.state, "untracked");
});

test("malformed documents and duplicate IDs are surfaced rather than silently treated as absent", async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.add({}, "duplicate");
  await f.files.create(".project-dev/knowledge/broken.md", "not front matter");
  const result = await searchKnowledge(f.files, { modules: ["accounts"] });
  assert.equal(result.outcome, "incomplete");
  assert.equal(data(result).results.length, 0);
  assert.ok(result.diagnostics.some((item) => item.code === "DUPLICATE_KNOWLEDGE_ID"));
  assert.ok(result.diagnostics.some((item) => item.code === "KNOWLEDGE_FILE_INVALID"));
});

test("read boundaries reject symlinked knowledge and report oversized content", async (t) => {
  const f = await fixture(t);
  await symlink(join(f.root, "docs/policy.md"), join(f.root, ".project-dev/knowledge/link.md"));
  await writeFile(join(f.root, ".project-dev/knowledge/huge.md"), "x".repeat(32_769));
  const result = await searchKnowledge(f.files, { query: "accounts" });
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.diagnostics.length, 2);
  await assert.rejects(searchKnowledge(f.files, { paths: ["../outside"] }));
});

test("invalid config fails explicitly; limits and excluded scopes are visible", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 7; index++) await f.add({ id: `session-${index}` });
  const result = data(await searchKnowledge(f.files, { modules: ["accounts"], limit: 2 }));
  assert.equal(result.results.length, 2);
  assert.equal(result.eligible_count, 7);
  assert.equal(result.truncated, true);
  assert.equal((await searchKnowledge(f.files, { paths: ["node_modules/test.js"] })).code, "PATHS_EXCLUDED");
  await writeFile(join(f.root, ".project-dev/project.yaml"), "schema_version: 1\nknowledge_dir: ../outside\n");
  await assert.rejects(searchKnowledge(f.files, { query: "account" }), { code: "INVALID_PROJECT_CONFIG" });
});
