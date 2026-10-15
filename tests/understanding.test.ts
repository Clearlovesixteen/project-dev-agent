import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { mapFiles, models, readMap } from "../src/understanding/store.js";
import { KnowledgeService } from "../src/knowledge/service.js";

async function setup(t: { after: (action: () => Promise<void>) => void }) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root), service = new UnderstandingService(binding);
  const put = async (path: string, text: string) => { await mkdir(join(binding.root, path, ".."), { recursive: true }); await writeFile(join(binding.root, path), text); };
  await put("src/pages/orders/index.tsx", "import {state} from '@/shared/status';\nimport {query} from '../../api/orders';\n// import ignored from './fake';\nexport const label = state;\n");
  await put("src/shared/status.ts", "export const state = 'pending';\n");
  await put("src/api/orders.ts", "export const query = () => '/orders';\n");
  await put("tsconfig.json", '{/* aliases */ "compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"],},},}');
  await put("package.json", '{"dependencies":{"react":"19.0.0"},"scripts":{"test":"touch DO_NOT_EXECUTE"}}');
  const input = async () => {
    const map = (await readMap(files))!, source = (await mapFiles(files)).find((file) => file.path === "src/pages/orders/index.tsx")!;
    return { scan_id: map.scan_id, id: "order-state", expected_revision: 0, module: "src/pages/orders", title: "订单状态展示",
      scope: ["src/pages/orders"], summary: "当前页面读取共享状态，后端状态转换未知。", entities: [{ name: "state", meaning: "共享显示状态" }],
      flows: [{ name: "显示", steps: ["读取共享定义", "呈现状态"] }], rules: [{ description: "页面读取状态", responsibility: "frontend" }],
      related_paths: [source.path, "src/shared/status.ts"], sources: [{ path: source.path, sha256: source.sha256, line: 4, quote: "export const label = state;" }], questions: ["后端如何转换状态？"] };
  };
  return { fixture, binding, files, service, put, input };
}

test("structure scan indexes modules, aliases and consumers without executing scripts or changing dirty work", async (t) => {
  const { binding, files, service, put } = await setup(t);
  await put(".env.local", "password=private-value"); await put("dist/generated.ts", "export const secret = 1");
  const before = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: binding.root, encoding: "utf8" });
  const result = await service.scan({}); assert.equal(result.outcome, "ok", JSON.stringify(result));
  const indexed = await mapFiles(files), page = indexed.find((file) => file.path === "src/pages/orders/index.tsx")!;
  assert.equal(page.module, "src/pages/orders"); assert.equal(page.role, "page");
  assert.deepEqual(page.imports.map((item) => item.target).sort(), ["src/api/orders.ts", "src/shared/status.ts"]);
  assert.ok(!indexed.some((file) => /\.env|generated/.test(file.path)));
  const context = (await service.context({ paths: ["src/shared/status.ts"] })).data as any;
  assert.ok(context.files.some((file: any) => file.path === page.path && file.relation === "direct_consumer"));
  assert.equal(context.files[0].source_state, "current");
  assert.equal(execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: binding.root, encoding: "utf8" }), before);
  await assert.rejects(readFile(join(binding.root, "DO_NOT_EXECUTE")), { code: "ENOENT" });
});

test("repeat scans reuse extraction but re-resolve aliases and find added/deleted files", async (t) => {
  const { binding, service, files, put } = await setup(t);
  await service.scan({}); const first = (await readMap(files))!;
  await service.scan({}); const second = (await readMap(files))!;
  assert.equal(second.scan_id, first.scan_id); assert.equal(second.coverage.reused, second.coverage.indexed);
  await put("src/new/status.ts", "export const state = 'new';\n");
  assert.deepEqual(((await service.context({ paths: ["src/new/status.ts"] })).data as any).unindexed_paths, ["src/new/status.ts"]);
  await put("tsconfig.json", '{"compilerOptions":{"paths":{"@/shared/*":["src/new/*"]}}}');
  assert.equal(((await service.context({})).data as any).state, "needs_rescan");
  await unlink(join(binding.root, "src/api/orders.ts"));
  await service.scan({}); const page = (await mapFiles(files)).find((file) => file.path === "src/pages/orders/index.tsx")!;
  assert.equal(page.imports[0]!.target, "src/new/status.ts"); assert.equal(page.imports[1]!.target, null);
  assert.notEqual((await readMap(files))!.scan_id, first.scan_id);
});

test("models validate current exact evidence, preserve revisions and flag all related changes", async (t) => {
  const { service, files, input, put, binding } = await setup(t);
  await service.scan({}); const model = await input();
  assert.equal((await service.record({ ...model, sources: [{ ...model.sources[0], quote: "invented" }] })).code, "PROJECT_MODEL_EVIDENCE_INVALID");
  assert.equal((await service.record({ ...model, sources: [{ ...model.sources[0], line: 1 }] })).code, "PROJECT_MODEL_EVIDENCE_INVALID");
  assert.equal((await service.record({ ...model, sources: [{ ...model.sources[0], sha256: "0".repeat(64) }] })).code, "PROJECT_SOURCE_CHANGED");
  assert.equal((await service.record(model)).outcome, "ok");
  assert.equal((await service.record(model)).code, "PROJECT_MODEL_REVISION_CONFLICT");
  assert.equal((await service.record({ ...model, expected_revision: 1, summary: "审查后的补充理解" })).outcome, "ok");
  assert.equal((await models(files))[0]!.revision, 2);
  const saved = (await models(files))[0]!;
  assert.equal(saved.rules[0]!.responsibility, "frontend");
  assert.equal(saved.sources[0]!.quote, "export const label = state;");
  const report = await files.read(".project-dev/local/understanding/report.html", 65_536);
  assert.match(report, /前端：页面读取状态/);
  assert.match(report, /页面 · src\/pages\/orders/);
  assert.match(report, /export const label = state;/);
  assert.equal((await readdir(join(binding.root, ".project-dev/local/understanding/models"))).length, 2);
  const search = (await new KnowledgeService(binding).search({ query: "订单", paths: ["src/pages/orders/index.tsx"] })).data as any;
  assert.equal(search.understanding.models[0].status, "candidate"); assert.equal(search.understanding.models[0].effective, false);
  await put("src/shared/status.ts", "export const state = 'closed';\n");
  const context = (await service.context({ paths: ["src/pages/orders"] })).data as any;
  assert.equal(context.models[0].status, "needs_review");
  assert.ok(context.models[0].source_states.some((source: any) => source.path === "src/shared/status.ts" && source.state === "changed"));
  assert.equal((await service.record({ ...model, expected_revision: 2 })).code, "PROJECT_SOURCE_CHANGED");
});

test("excluded paths and freshly excluded model sources cannot leak through context or combined search", async (t) => {
  const { service, put, input, binding } = await setup(t);
  await service.scan({}); await service.record(await input());
  await put(".project-dev/project.yaml", 'schema_version: 1\nexclude_paths:\n  - src/pages/orders\n');
  assert.equal(((await service.context({ paths: ["src/pages/orders"] })).data as any).state, "paths_excluded");
  const search = (await new KnowledgeService(binding).search({ query: "订单", paths: ["src/pages/orders", "src/shared/status.ts"] })).data as any;
  assert.equal(search.understanding.models.length, 0);
  assert.ok(!search.understanding.files.some((entry: any) => entry.path.startsWith("src/pages/orders")));
  assert.equal((await service.context({ paths: ["../../outside"] })).outcome, "error");
});

test("unreadable, nested and linked sources produce honest partial coverage without following links", async (t) => {
  const { service, files, binding, put } = await setup(t);
  await symlink("/etc/hosts", join(binding.root, "src/linked.ts"));
  await put("nested/.git/config", ""); await put("nested/source.ts", "export const nested = 1");
  await put("src/huge.ts", "a".repeat(512_001));
  const result = await service.scan({}); assert.equal(result.outcome, "incomplete");
  assert.equal((await readMap(files))!.coverage.complete, false);
  assert.ok(!(await mapFiles(files)).some((entry) => /linked|nested|huge/.test(entry.path)));
});

test("all indexed records can be browsed in bounded escaped HTML pages", async (t) => {
  const { service, files, put } = await setup(t);
  for (let i = 0; i < 65; i++) await put(`src/pages/a&b/file-${i}.ts`, "export const value = 1");
  assert.equal((await service.scan({})).outcome, "ok");
  let path = "report.html", page = 0, html = "";
  while (path) {
    const current = await files.read(`.project-dev/local/understanding/${path}`, 65_536); html += current;
    assert.ok(++page < 20); path = /href="(report-\d+\.html)">下一页/.exec(current)?.[1] ?? "";
  }
  assert.ok(page > 1); assert.ok(html.includes("a&amp;b/file-64.ts"));
  for (const file of await mapFiles(files)) assert.ok(html.includes(file.sha256.slice(0, 12)));
});

test("interrupted or concurrent writers preserve the published map and reject unrelated identities", async (t) => {
  const { service, files, input, put } = await setup(t);
  assert.equal(((await service.context({})).data as any).state, "not_scanned");
  await service.scan({}); const before = await readMap(files);
  await put(".project-dev/local/understanding/operation.lock", JSON.stringify({ pid: process.pid, token: "someone-else" }));
  assert.equal((await service.scan({})).code, "PROJECT_MAP_BUSY");
  assert.equal((await service.record(await input())).code, "PROJECT_MAP_BUSY");
  assert.deepEqual(await readMap(files), before);
  await put(".project-dev/local/understanding/manifest.json", JSON.stringify({ ...before, project: "/other-project" }));
  assert.equal((await service.context({})).code, "PROJECT_MAP_MISMATCH");
});
