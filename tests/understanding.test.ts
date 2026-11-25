import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat, unlink, symlink, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { mapFiles, models, readMap } from "../src/understanding/store.js";
import { digest } from "../src/knowledge/document.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { ProjectKnowledgeRepository } from "../src/project-knowledge/repository.js";
import { prepareProject } from "../src/personal-setup.js";
import { publishModelShadow } from "../src/project-knowledge/service.js";
import { loadWorktreeModels } from "../src/project-knowledge/worktree-models.js";

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
  const report = join(binding.root, ".project-dev/local/understanding/report.html");
  const beforeReport = await stat(report, { bigint: true });
  await service.scan({}); const second = (await readMap(files))!;
  assert.equal(second.scan_id, first.scan_id); assert.equal(second.coverage.reused, second.coverage.indexed);
  assert.equal(second.scanned_at, first.scanned_at);
  assert.equal((await stat(report, { bigint: true })).ino, beforeReport.ino);
  await unlink(report);
  await service.scan({});
  assert.match(await readFile(report, "utf8"), /订单|src\/pages\/orders/);
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
  assert.equal((await service.record({ ...model, knowledge_view_token: "0".repeat(64) })).code, "PROJECT_KNOWLEDGE_VIEW_STALE");
  assert.equal((await models(files)).length, 0, "过期共享视图不能先写入本地模型");
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
  assert.equal(context.models[0].id, "order-state");
  assert.equal(context.models[0].review_only, true, "过期模型只能作为显式复核候选返回");
  assert.equal(context.models[0].effective, false);
  assert.equal(context.models[0].status, "needs_review");
  assert.ok(context.models[0].source_states.some((source: any) => source.path === "src/shared/status.ts" && source.state === "changed"));
  assert.equal(context.review_candidates[0].id, "order-state");
  const loaded = await loadWorktreeModels(binding, files);
  assert.deepEqual(loaded.models, [], "needs_review 模型不能回退为当前工作模型");
  assert.equal(loaded.reviewCandidates[0]!.id, "order-state");
  assert.equal((await service.record({ ...model, expected_revision: 2 })).code, "PROJECT_SOURCE_CHANGED");
});

test("共享模型已提交而本地索引中断时，下一次模型记录会补偿并清理恢复标记", async (t) => {
  const { service, files, input } = await setup(t);
  await service.scan({});
  const model = await input();
  assert.equal((await service.record(model)).outcome, "ok");
  const saved = (await models(files))[0]!;
  const indexPath = ".project-dev/local/understanding/models.json";
  const index = await files.read(indexPath);
  await files.replace(indexPath, "[]\n", index);
  const markerPath = ".project-dev/local/model-sync/order-state.json";
  const markerBefore = await files.read(markerPath);
  await files.replace(markerPath, `${JSON.stringify({
    schema_version: 1, state: "pending", model_id: saved.id, revision: saved.revision,
    snapshot_id: "0".repeat(64), model: saved, created_at: new Date().toISOString(),
  })}\n`, markerBefore, 1_048_576);
  assert.equal((await service.record({ ...model, expected_revision: 1, summary: "恢复后的模型修订" })).outcome, "ok");
  assert.equal((await models(files)).find(item => item.id === saved.id)?.revision, 2);
  const marker = JSON.parse(await files.read(".project-dev/local/model-sync/order-state.json"));
  assert.equal(marker.state, "resolved");
  assert.equal(marker.model, undefined);
});

test("saved model is shadow-published to the project knowledge store and invalidated by current code", async (t) => {
  const { service, input, put, binding } = await setup(t);
  await service.scan({});
  const model = await input();
  assert.equal((await service.record(model)).outcome, "ok");
  const first = (await service.context({ paths: ["src/pages/orders"] })).data as any;
  assert.equal(first.project_knowledge.state, "matched");
  assert.equal(first.project_knowledge.snapshot_count, 1);
  assert.ok(first.project_knowledge.view_token);
  assert.equal(first.project_knowledge.selected_models[0].model_id, "order-state");
  assert.equal(first.project_knowledge.selected_models[0].trust.state, "candidate");
  assert.equal(first.project_knowledge.selected_models[0].content.id, "order-state");
  assert.equal(first.project_knowledge.selected_models[0].content.project, undefined);
  const repository = await ProjectKnowledgeRepository.openExisting(binding.repo_identity);
  assert.ok(repository);
  const snapshot = await repository.readObject((await repository.currentObjectIds())[0]!);
  const provenance = (snapshot.content as any).provenance;
  const snapshotContent = snapshot.content as any;
  assert.deepEqual(snapshotContent.source_fingerprints.map((item: any) => item.path), ["src/pages/orders/index.tsx"]);
  assert.deepEqual(snapshotContent.dependency_fingerprints.map((item: any) => item.path), ["src/shared/status.ts"]);
  assert.deepEqual(new Set(snapshotContent.configuration_fingerprints.map((item: any) => item.path)), new Set(["package.json", "tsconfig.json"]));
  assert.equal(provenance.repo_identity, binding.repo_identity);
  assert.equal(provenance.head, binding.head);
  assert.match(provenance.worktree_id, /^[a-f0-9]{64}$/);
  assert.match(provenance.source_stamp_id, /^[a-f0-9]{64}$/);
  await put("src/shared/status.ts", "export const state = 'closed';\n");
  const changed = (await service.context({ paths: ["src/pages/orders"] })).data as any;
  assert.equal(changed.project_knowledge.state, "needs_review");
  assert.ok(changed.project_knowledge.unresolved.some((item: string) => item.startsWith("order-state:")));
});

test("当前源码匹配显式拒绝的快照时，完整响应也撤回正文和旧本地副本", async t => {
  const { service, input, binding } = await setup(t);
  await service.scan({});
  const model = await input();
  const original = await service.record(model);
  const repository = (await ProjectKnowledgeRepository.openExisting(binding.repo_identity))!;
  const prior = await repository.readObject((original.data as any).snapshot_id);
  const content = { ...prior.content as object, parent_snapshot_ids: [prior.object_id],
    trust: { state: "rejected", reason: "复核确认规则不适用" } };
  await repository.publish({ operation_id: "reject-model", objects: [
    { ...prior, object_id: digest(JSON.stringify(content)), content },
  ] });
  const full = (await service.context({ paths: model.scope })).data as any;
  assert.equal(full.project_knowledge.modules[0].state, "matched");
  assert.deepEqual(full.project_knowledge.selected_models, []);
  assert.deepEqual(full.models, []);
  assert.deepEqual(full.review_candidates, []);
});

test("首次准备会把旧工作树模型影子迁移到项目公共知识库，不把分支内容直接合并", async (t) => {
  const { service, input, binding } = await setup(t);
  await service.scan({});
  assert.equal((await service.record(await input())).outcome, "ok");
  const repository = (await ProjectKnowledgeRepository.openExisting(binding.repo_identity))!;
  await rm(repository.files.root, { recursive: true, force: true });
  const prepared = await prepareProject(binding, { apply: true });
  const knowledge = (prepared.data as any).project_knowledge;
  assert.equal(knowledge.migration.attempted, 1);
  assert.equal(knowledge.migration.published, 1);
  assert.deepEqual(knowledge.migration.failed, []);
  assert.equal(knowledge.snapshot_count, 1);
  const retry = (await prepareProject(binding, { apply: true })).data as any;
  assert.equal(retry.project_knowledge.migration.attempted, 0);
  assert.equal(retry.project_knowledge.migration.reused, 1);
  const daily = (await prepareProject(binding, { apply: true, include_recovery: false })).data as any;
  assert.deepEqual(daily.task_recovery, { branch: binding.branch, state: "not_requested" });
  assert.equal(daily.worktree_clean, retry.worktree_clean);
  assert.deepEqual(daily.active_task, retry.active_task);
  assert.equal(daily.merge_recovery_ready, retry.merge_recovery_ready);
  assert.equal(daily.history.state, "not_scanned");
  assert.ok(Array.isArray(retry.task_recovery.preserved));
  const restored = (await service.context({})).data as any;
  assert.equal(restored.project_knowledge.state, "matched");
  assert.equal(restored.project_knowledge.selected_models[0].model_id, "order-state");
});

test("日常实现摘要只带已验证的模型入口，源码变化时撤回过期视图", async t => {
  const { service, input, put } = await setup(t);
  await service.scan({}); await service.record(await input());
  const query = { view: "compact", paths: ["src/pages/orders"] };
  const current = (await service.context(query)).data as any;
  assert.equal(current.context_query_kind, "implementation");
  assert.ok(Array.isArray(current.implementation_context.implementation_candidates.candidates));
  assert.ok(Array.isArray(current.knowledge_context.results));
  assert.equal(current.project_knowledge.state, "matched");
  assert.equal(current.project_knowledge.selected_models, undefined);
  assert.equal(current.models[0].details_request.model_id, "order-state");
  const full = (await service.context({ view: "compact", model_id: "order-state" })).data as any;
  assert.ok(full.models[0].sources);
  await put("src/shared/status.ts", "export const state = 'closed';\n");
  const changed = (await service.context(query)).data as any;
  assert.equal(changed.project_knowledge.state, "needs_review");
  assert.notEqual(current.context_id, changed.context_id);
});

test("待复核 v3 规则只供核对，紧凑实施视图撤回位置和保留行为", async t => {
  const { service, input, put } = await setup(t);
  await service.scan({});
  const original = await input(), source = { ...original.sources[0]!, id: "order-line", kind: "code" };
  const ruleId = "order-label", refs = [source.id];
  const recorded = await service.record({ ...original, schema_version: 3, revision_reason: "核对订单标签入口",
    sources: [source], relations: [], rules: [{ ...original.rules[0], id: ruleId, basis: "observed", conditions: ["进入订单页面"],
      exceptions: [], source_ids: refs, bindings: [{ id: "label-entry", path: source.path, symbol: "label", role: "reuse", source_ids: refs }],
      semantics: { subject: "order", action: "display", when: { field: "visible", op: "eq", value: true }, expected: "显示状态",
        source_ids: refs, cases: [], preserves: [{ id: "label", description: "保留订单状态标签", source_ids: refs }] } }] });
  assert.equal(recorded.outcome, "ok", JSON.stringify(recorded));
  const query = { view: "compact", paths: ["src/pages/orders"] };
  const before = (await service.context(query)).data as any;
  assert.ok(before.implementation_view_v1.reuse.items.some((item: any) => item.binding_id === "label-entry"));
  assert.ok(before.implementation_view_v1.preserved_behaviors.items.some((item: any) => item.model_id === original.id));

  // 只变更依赖；源码绑定本身仍能定位，更能检验旧规则是否重新混入实施依据。
  await put("src/shared/status.ts", "export const state = 'closed';\n");
  const compact = (await service.context(query)).data as any;
  assert.deepEqual(compact.models, []);
  assert.equal(compact.review_candidates[0].review_only, true);
  assert.equal(compact.review_candidates[0].effective, false);
  assert.equal(compact.review_candidates[0].rules, undefined);
  for (const role of ["modify", "reuse", "verify", "protect", "inspect", "preserved_behaviors"])
    assert.ok(compact.implementation_view_v1[role].items.every((item: any) => item.model_id !== original.id), role);
  const unrelated = (await service.context({ view: "compact", paths: ["src/other"] })).data as any;
  assert.deepEqual(unrelated.review_candidates, []);
  const full = (await service.context({ paths: query.paths })).data as any;
  assert.equal(full.models[0].review_only, true, "v3 分页摘要须保留复核标记");
  for (const extra of [{}, { model_snapshot_id: (recorded.data as any).snapshot_id }]) {
    const detail = (await service.context({ model_id: original.id, rule_ids: [ruleId], ...extra })).data as any;
    assert.equal(detail.models[0].review_only, true);
    assert.equal(detail.models[0].status, "needs_review");
    assert.equal(detail.business_checks, undefined);
  }
});

test("同一源码内容仅改变 staged 状态时不会产生重复的共享业务候选", async (t) => {
  const { service, input, files, binding } = await setup(t);
  await service.scan({});
  assert.equal((await service.record(await input())).outcome, "ok");
  const local = (await models(files))[0]!;
  const repository = (await ProjectKnowledgeRepository.openExisting(binding.repo_identity))!;
  const before = await repository.currentObjectIds();
  execFileSync("git", ["add", "src/shared/status.ts"], { cwd: binding.root });
  await publishModelShadow(binding, local as unknown as Record<string, unknown>);
  const after = await repository.currentObjectIds();
  const snapshots = (await Promise.all(after.map(id => repository.readObject(id)))).filter(object => object.object_type === "module_snapshot");
  assert.equal(new Set(snapshots.map(object => object.object_id)).size, 1);
  assert.ok(after.length >= before.length);
  assert.equal(((await service.context({})).data as any).project_knowledge.state, "matched");
});

test("合并后的共享快照保留 A/B 两个最大父快照，不把整合记录成单分支覆盖", async (t) => {
  const { service, files, binding } = await setup(t);
  await service.scan({});
  const entries = await mapFiles(files);
  const page = entries.find(entry => entry.path === "src/pages/orders/index.tsx")!;
  const status = entries.find(entry => entry.path === "src/shared/status.ts")!;
  const common = { id: "parallel-model", module: "src/pages/orders", revision: 1, recorded_at: "2026-01-01T00:00:00.000Z" };
  await publishModelShadow(binding, { ...common, related_versions: [{ path: page.path, sha256: page.sha256 }] });
  await publishModelShadow(binding, { ...common, related_versions: [{ path: status.path, sha256: status.sha256 }], recorded_at: "2026-01-01T00:00:01.000Z" });
  await publishModelShadow(binding, { ...common, revision: 2, related_versions: [{ path: page.path, sha256: page.sha256 }, { path: status.path, sha256: status.sha256 }] });
  const repository = (await ProjectKnowledgeRepository.openExisting(binding.repo_identity))!;
  const snapshots = (await Promise.all((await repository.currentObjectIds()).map(id => repository.readObject(id))))
    .filter(object => object.object_type === "module_snapshot")
    .map(object => ({ id: object.object_id, content: object.content as any }))
    .filter(object => object.content.model_id === "parallel-model");
  const combined = snapshots.find(object => object.content.content.revision === 2)!;
  assert.deepEqual(new Set(combined.content.parent_snapshot_ids), new Set(snapshots.filter(object => object.content.content.revision === 1).map(object => object.id)));
});

test("同一工作树的模型修订会保留共享快照父链，不能把不同源码证据当作自动合并", async (t) => {
  const { service, input, binding } = await setup(t);
  await service.scan({});
  assert.equal((await service.record(await input())).outcome, "ok");
  const repository = (await ProjectKnowledgeRepository.openExisting(binding.repo_identity))!;
  const firstId = (await repository.currentObjectIds())[0]!;
  assert.equal((await service.record({ ...await input(), expected_revision: 1, summary: "同一证据下的修订" })).outcome, "ok");
  const ids = await repository.currentObjectIds();
  const second = await repository.readObject(ids.find(id => id !== firstId)!);
  assert.deepEqual((second.content as any).parent_snapshot_ids, [firstId]);
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

test("模型可按关联文件、流程和待确认问题检索", async (t) => {
  const { service, input } = await setup(t);
  await service.scan({});
  const model = { ...await input(), flows: [{ name: "refundqueue", steps: ["检查状态后进入队列"] }], questions: ["谁负责 settlementowner？"] };
  assert.equal((await service.record(model)).outcome, "ok");
  for (const query of [{ paths: ["src/shared/status.ts"] }, { query: "refundqueue" }, { query: "settlementowner" }]) {
    assert.equal(((await service.context(query)).data as any).models[0]?.id, model.id);
  }
});

test("大模型返回摘要且可读取完整详情，后续模型不会被挤掉", async (t) => {
  const { service, input, files, put } = await setup(t);
  await service.scan({});
  const model = { ...await input(), id: "a-large", flows: Array.from({ length: 5 }, (_, i) => ({ name: `流程${i}`, steps: Array(4).fill("分析业务边界".repeat(116)) })) };
  assert.equal((await service.record(model)).outcome, "ok");
  assert.ok(Buffer.byteLength(JSON.stringify((await models(files))[0])) > 36_000);
  for (let i = 0; i < 6; i++) assert.equal((await service.record({ ...await input(), id: `other-${i}` })).outcome, "ok");
  const page = (await service.context({ paths: ["src/pages/orders"] })).data as any;
  assert.equal(page.models.length, 5);
  assert.equal(page.models[0].id, model.id);
  assert.equal(page.models[0].content_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page.models)) <= 36_000);
  assert.equal(page.next_model_offset, 5);
  const detail = (await service.context(page.models[0].details_request)).data as any;
  assert.deepEqual(detail.models[0].flows, model.flows);
  assert.equal(detail.models[0].effective, false);
  const tail = (await service.context({ paths: ["src/pages/orders"], model_offset: page.next_model_offset })).data as any;
  assert.equal(tail.models.length, 2); assert.equal(tail.next_model_offset, null);
  assert.equal((await service.context({ model_id: model.id, model_revision: 99 })).code, "PROJECT_MODEL_REVISION_CONFLICT");
  await put(".project-dev/project.yaml", 'schema_version: 1\nexclude_paths:\n  - src/shared/status.ts\n');
  assert.equal((await service.context({ model_id: model.id })).code, "PROJECT_MODEL_NOT_FOUND");
});

test("历史读取异常不会丢掉已获取的业务模型", async (t) => {
  const { service, input, binding, put } = await setup(t);
  await service.scan({}); await service.record(await input());
  await put(".project-dev/local/history/manifest.json", "{invalid");
  const result = await new KnowledgeService(binding).search({ paths: ["src/pages/orders"] });
  assert.equal(result.outcome, "incomplete");
  assert.equal((result.data as any).understanding.models[0].id, "order-state");
  assert.equal((result.data as any).history.state, "unavailable");
  assert.equal(result.diagnostics[0]?.code, "HISTORY_HINTS_UNAVAILABLE");
});
