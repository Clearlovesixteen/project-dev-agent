import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFiles } from "../src/storage/project-files.js";
import { KnowledgeSchema } from "../src/domain/knowledge.js";
import { digest, renderKnowledge } from "../src/knowledge/document.js";
import { searchKnowledge } from "../src/knowledge/search.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-match-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ProjectFiles(root);
  await files.directory("docs"); await files.create("docs/standard.md", "Use project components when suitable.\n");
  await files.directory(".project-dev/knowledge");
  await files.create(".project-dev/project.yaml", "schema_version: 1\nmodules:\n  - name: accounts\n    paths: [src/accounts]\n  - name: billing\n    paths: [src/billing]\n");
  const base = KnowledgeSchema.parse({ schema_version: 1, id: "component", title: "复用组件", type: "code_convention", status: "confirmed", modules: ["accounts"],
    paths: ["src/accounts/**/*.ts"], applicable_conditions: ["已有组件满足需求"], rule: "优先复用组件", rationale: "统一行为", sources: [{ kind: "document", reference: "docs/standard.md", sha256: digest(await files.read("docs/standard.md")) }],
    confirmed_by: "fixture", reviewed_at: "2026-10-23T00:00:00Z" });
  const add = async (overrides = {}) => { const rule = KnowledgeSchema.parse({ ...base, ...overrides }); await files.create(`.project-dev/knowledge/${rule.id}.md`, renderKnowledge(rule)); };
  const search = async (input: unknown) => (await searchKnowledge(files, input)).data as any;
  return { root, files, add, search };
}

test("返回精确路径 pattern、模块和关键词原因，但自然语言适用条件仍待核对", async t => {
  const f = await fixture(t); await f.add();
  const result = await f.search({ query: "组件", modules: ["accounts"], paths: ["src/accounts/form.ts"] });
  assert.equal(result.results.length, 1); const match = result.results[0].match_explanation;
  assert.deepEqual(match.matched_paths, [{ pattern: "src/accounts/**/*.ts", path: "src/accounts/form.ts" }]);
  assert.deepEqual(match.matched_modules, ["accounts"]); assert.ok(match.matched_terms.length > 0);
  assert.deepEqual(match.matched_terms, result.results[0].matched_terms);
  assert.equal(match.condition_check, "required"); assert.equal(result.results[0].effective, true);
  assert.equal((await f.search({ paths: ["src/accounts-other/form.ts"] })).results.length, 0);
  assert.equal((await f.search({ modules: ["billing"], paths: ["src/accounts/form.ts"] })).results.length, 0);
});

test("解释 module-only 从路径归属的匹配，path-only 模块查询保持原有语义", async t => {
  const f = await fixture(t); await f.add({ id: "module", paths: [] });
  await f.add({ id: "path", modules: [], paths: ["src/accounts"] });
  const pathQuery = await f.search({ paths: ["src/accounts/form.ts"] });
  assert.deepEqual(pathQuery.results.find((item: any) => item.id === "module").match_explanation.matched_modules, ["accounts"]);
  const moduleQuery = await f.search({ modules: ["accounts"] });
  assert.deepEqual(moduleQuery.results.find((item: any) => item.id === "path").match_explanation.module_path_matches,
    [{ module: "accounts", pattern: "src/accounts", rule_path: "src/accounts" }]);
  assert.equal((await f.search({ modules: ["billing"] })).results.length, 0);
});

test("命中解释不将候选、停用或过期规则提升为有效约束", async t => {
  const f = await fixture(t); await f.add(); await f.add({ id: "candidate", status: "candidate" }); await f.add({ id: "disabled", status: "disabled" });
  await writeFile(join(f.root, "docs/standard.md"), "Changed standard.\n");
  const normal = await f.search({ paths: ["src/accounts/form.ts"] }); assert.equal(normal.results.length, 0);
  const hints = await f.search({ paths: ["src/accounts/form.ts"], include_unconfirmed: true });
  assert.deepEqual(hints.results.map((item: any) => item.id).sort(), ["candidate", "component"]);
  assert.ok(hints.results.every((item: any) => !item.effective && item.match_explanation.condition_check === "required"));
  assert.equal(hints.results.find((item: any) => item.id === "component").status, "needs_review");
});
