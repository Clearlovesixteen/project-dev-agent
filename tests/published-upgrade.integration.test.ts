import assert from "node:assert/strict";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { ProjectKnowledgeRepository } from "../src/project-knowledge/repository.js";
import { readProjectKnowledge } from "../src/project-knowledge/service.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { mapFiles, modelIndex, readMap } from "../src/understanding/store.js";
import { withSampleGit } from "../src/sample/git-isolation.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const sourcePath = "src/project-status.js";
const modelId = "project-status";
const marker = (value: string) => `export const status = "${value}";\n`;

/** 每棵工作树使用自己的扫描、代码和任务文件，测试只共享实际的 Git 公共目录。 */
async function modelFixture(t: test.TestContext) {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  // 验证用的提交与合并沿用样例仓库的隔离环境，Git 身份由用例提供。
  const git = (root: string, ...args: string[]) => withSampleGit(fixture.root, run => run(root, args));
  await writeFile(join(fixture.path, sourcePath), marker("initial"));
  await git(fixture.path, "add", "--", sourcePath);
  await git(fixture.path, "commit", "-m", "Initial shared status");
  const home = join(fixture.root, "isolated-codex");
  await mkdir(home);
  const settings = new PluginSettings(home);

  async function attach(root: string) {
    await settings.prepare(root, { apply: true });
    const binding = await bindWorktree(root), files = new ProjectFiles(binding.root), service = new UnderstandingService(binding);
    const scan = async () => {
      const result = await service.scan({});
      assert.ok(result.outcome !== "error", JSON.stringify(result));
      const entry = (await mapFiles(files)).find(item => item.path === sourcePath)!;
      const quote = (await readFile(join(binding.root, sourcePath), "utf8")).trim();
      return { scan_id: (await readMap(files))!.scan_id, source: { id: "code", kind: "code", path: sourcePath, line: 1, sha256: entry.sha256, quote } };
    };
    const context = async (args: Record<string, unknown> = {}) => {
      const result = await service.context(args);
      assert.notEqual(result.outcome, "error", JSON.stringify(result));
      return result.data as { models: Array<{ summary: string; revision: number; current_snapshot_id?: string; historical_snapshot_id?: string }>;
        state: string; project_knowledge: Awaited<ReturnType<typeof readProjectKnowledge>> };
    };
    return { binding, files, service, scan, context, set: (status: string) => writeFile(join(binding.root, sourcePath), marker(status)) };
  }
  const a = await attach(fixture.path);
  const branch = async (name: string) => {
    const root = join(fixture.root, name);
    await git(fixture.path, "worktree", "add", "-b", name, root, "HEAD");
    return attach(root);
  };
  const { scan_id, source } = await a.scan();
  const rule = { id: "behavior", description: "状态从公共入口读取", responsibility: "frontend",
    basis: "observed", conditions: ["读取状态"], exceptions: [], source_ids: ["code"] };
  assert.equal((await a.service.record({
    scan_id, id: modelId, schema_version: 2, expected_revision: 0, revision_reason: "读取初始状态入口",
    module: "src", title: "项目状态", scope: [sourcePath], summary: "初始业务规则", entities: [], flows: [], questions: [],
    related_paths: [sourcePath], rules: [rule], sources: [source], relations: [],
  })).code, "PROJECT_MODEL_RECORDED");
  const baseline = (await a.context({ model_id: modelId })).models[0]!.current_snapshot_id!;
  const input = async (tree: Awaited<ReturnType<typeof attach>>, summary: string, revision: number, base?: string, reviewed?: string[]) => {
    const { scan_id, source } = await tree.scan();
    const { project_knowledge } = await tree.context();
    return { scan_id, id: modelId, schema_version: 2, expected_revision: revision, revision_reason: "核对当前代码的状态规则",
      knowledge_view_token: project_knowledge.view_token,
      ...(base ? { base_snapshot_id: base } : {}), ...(reviewed ? { reviewed_snapshot_ids: reviewed } : {}),
      patch: { metadata: { summary }, upsert_sources: [source], upsert_rules: [{ ...rule, description: summary }] } };
  };
  return { fixture, a, branch, baseline, input, settings, git };
}

test("linked worktree 从常规业务查询直接读取共享模型，冲突复核后各分支继续取得自己的适用模型", async t => {
  const { a, branch, baseline, input, settings, git } = await modelFixture(t);
  const b = await branch("version-b"), integration = await branch("integration");
  await b.scan();
  assert.deepEqual(await modelIndex(b.files), []);
  assert.equal((await b.context({ model_id: modelId })).models[0]!.current_snapshot_id, baseline);
  const search = await new KnowledgeService(b.binding).search({ query: "项目状态", paths: [sourcePath] });
  assert.equal((search.data as { understanding: { models: { current_snapshot_id: string }[] } }).understanding.models[0]?.current_snapshot_id, baseline);

  await a.set("a");
  const aWrite = await a.service.record(await input(a, "A 分支当前规则", 1, baseline));
  assert.equal(aWrite.code, "PROJECT_MODEL_RECORDED", JSON.stringify(aWrite));
  const aId = (aWrite.data as { snapshot_id: string }).snapshot_id;
  await b.set("b");
  const bWrite = await b.service.record(await input(b, "B 分支当前规则", 1, baseline));
  assert.equal(bWrite.code, "PROJECT_MODEL_RECORDED", JSON.stringify(bWrite));
  const bId = (bWrite.data as { snapshot_id: string }).snapshot_id;
  assert.notEqual(aId, bId);
  assert.equal((await a.context({ model_id: modelId })).models[0]!.current_snapshot_id, aId);
  assert.equal((await b.context({ model_id: modelId })).models[0]!.current_snapshot_id, bId);

  // 先提交两个版本，再在单独工作树运行真正的 Git 合并并手工解决同一文件的冲突。
  for (const tree of [a, b]) {
    await git(tree.binding.root, "add", "--", sourcePath);
    await git(tree.binding.root, "commit", "-m", "Change branch status");
  }
  const integrationRoot = integration.binding.root;
  await git(integrationRoot, "merge", "--no-edit", a.binding.branch!);
  await assert.rejects(git(integrationRoot, "merge", "--no-edit", b.binding.branch!), { code: 1 });
  assert.equal(await git(integrationRoot, "diff", "--name-only", "--diff-filter=U"), sourcePath);
  await integration.set("combined");
  await git(integrationRoot, "add", "--", sourcePath);
  await git(integrationRoot, "commit", "-m", "Review combined status behavior");
  await integration.scan();
  const ambiguous = await integration.context({ model_id: modelId });
  assert.equal(ambiguous.project_knowledge.modules?.[0]?.state, "ambiguous");
  assert.deepEqual(ambiguous.models, []);
  assert.equal((await integration.service.record(await input(integration, "未复核不能认领", 2))).code, "PROJECT_MODEL_REVIEW_REQUIRED");
  // 只改摘要不能替用户决定两个父快照中同一规则的不同表述。
  const unresolved = await input(integration, "未确认具体分歧", 2, aId, [bId]);
  const conflict = await integration.service.record({ ...unresolved, patch: { metadata: unresolved.patch.metadata } });
  assert.equal(conflict.code, "PROJECT_MODEL_MERGE_CONFLICT", JSON.stringify(conflict));
  const historical = await integration.context({ model_id: modelId, model_snapshot_id: bId });
  assert.equal(historical.models[0]?.historical_snapshot_id, bId);
  assert.equal(historical.state, "needs_review");

  const reviewed = await integration.service.record(await input(integration, "合并后的已核对规则", 2, aId, [bId]));
  assert.equal(reviewed.code, "PROJECT_MODEL_RECORDED", JSON.stringify(reviewed));
  const combined = (await integration.context({ model_id: modelId })).models[0]!;
  assert.equal(combined.revision, 3);
  const repository = (await ProjectKnowledgeRepository.openExisting(a.binding.repo_identity))!;
  const combinedObject = await repository.readObject(combined.current_snapshot_id!);
  assert.deepEqual((combinedObject.content as { parent_snapshot_ids: string[] }).parent_snapshot_ids, [aId, bId]);
  const before = (await repository.current())!.transaction_id;
  await settings.prepare(b.binding.root, { apply: true });
  assert.equal((await repository.current())!.transaction_id, before, "重开旧工作树不能重复发布模型");
  await b.scan();
  assert.equal((await b.context({ model_id: modelId })).models[0]!.current_snapshot_id, bId);
});

test("两个工作树基于同一旧视图并发提交，只保存一个修订", async t => {
  const { a, branch, input, fixture } = await modelFixture(t);
  const b = await branch("concurrent-b");
  const [left, right] = await Promise.all([input(a, "A 并发修订", 1), input(b, "B 并发修订", 1)]);
  const results = await Promise.all([a.service.record(left), b.service.record(right)]);
  assert.equal(results.filter(result => result.code === "PROJECT_MODEL_RECORDED").length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.code === "PROJECT_KNOWLEDGE_VIEW_STALE").length, 1, JSON.stringify(results));
  const largeAsset = join(fixture.path, "large-unrelated.bin");
  await writeFile(largeAsset, "");
  await truncate(largeAsset, 9 * 1024 * 1024);
  const selected = await readProjectKnowledge(a.binding);
  assert.equal(selected.state, "matched", "无关的大文件不能阻断相关源码指纹核验");
  assert.equal(selected.snapshot_count, 2);
  assert.equal((await a.context({ model_id: modelId })).models[0]!.revision, 2);
});

test("当前工作树排除共享修订的来源时，查询不会降级使用同 ID 的旧副本", async t => {
  const { a, branch, baseline, input } = await modelFixture(t);
  const b = await branch("adds-source"), extra = "src/restricted-source.js";
  await Promise.all([a, b].map(tree => writeFile(join(tree.binding.root, extra), "export const extra = true;\n")));
  const request = await input(b, "引用额外来源的共享规则", 1, baseline);
  const published = await b.service.record({ ...request, patch: { ...request.patch,
    metadata: { ...request.patch.metadata, related_paths: [sourcePath, extra] } } });
  assert.equal(published.code, "PROJECT_MODEL_RECORDED", JSON.stringify(published));
  await a.scan();
  assert.equal((await a.context({ model_id: modelId })).models[0]!.revision, 2);
  await writeFile(join(a.binding.root, ".project-dev/project.yaml"), `schema_version: 1\nexclude_paths:\n  - ${extra}\n`);
  await a.scan();
  assert.equal((await modelIndex(a.files))[0]!.revision, 1);
  const current = await a.context();
  assert.equal(current.models.length, 0);
  assert.equal(current.project_knowledge.selected_models?.length, 0);
  assert.equal((await a.service.context({ model_id: modelId })).code, "PROJECT_MODEL_NOT_FOUND");
});

// 同一规则在两个真实工作树中增加不同场景；保存新规则后仍需分别保留两份父快照供回看。
test("同规则不同场景三方合并、旧场景遗漏和有依据的改名", async t => {
  const { a, branch, baseline, input } = await modelFixture(t);
  const left = await branch("delivery-ui"), right = await branch("delivery-api");
  const first = await input(a, "场景基线", 1, baseline);
  const rule = first.patch.upsert_rules[0]!;
  const scenario = (id: string) => ({ id, description: id, facts: { done: true }, expected: "allowed", source_ids: ["code"] });
  const retains = [{ id: "keep-old", description: "保留原状态", source_ids: ["code"] }];
  const semantics = (names: string[], preserve = retains) => ({ subject: "order", action: "approve",
    when: { field: "done", op: "eq", value: true }, expected: "已完成才可操作", cases: names.map(scenario), preserves: preserve, source_ids: ["code"] });
  const seed = await a.service.record({ ...first, schema_version: 3, patch: { upsert_rules: [{ ...rule, semantics: semantics(["old"]) }] } });
  assert.equal(seed.code, "PROJECT_MODEL_RECORDED", JSON.stringify(seed));
  const idOf = (result: typeof seed) => (result.data as { snapshot_id: string }).snapshot_id;
  const side = async (tree: typeof a, id: string) => {
    const draft = await input(tree, "保留初始规则", 2, idOf(seed));
    const result = await tree.service.record({ ...draft, schema_version: 3, patch: {
      upsert_rules: [{ ...rule, semantics: semantics(["old", id]) }, { ...rule, id: 'new-' + id, description: id }] } });
    assert.equal(result.code, "PROJECT_MODEL_RECORDED", JSON.stringify(result));
    return idOf(result);
  };
  const ui = await side(left, "ui"), api = await side(right, "api");
  const integration = await input(a, "同需求整合", 3, ui, [api]);
  const joint = await a.service.record({ ...integration, schema_version: 3, patch: { metadata: { summary: "共同交付" } } });
  assert.equal(joint.code, "PROJECT_MODEL_RECORDED", JSON.stringify(joint));
  const repository = (await ProjectKnowledgeRepository.openExisting(a.binding.repo_identity))!;
  const snapshot = (await repository.readObject(idOf(joint))).content as { parent_snapshot_ids: string[];
    content: {rules: {id: string; semantics?: {cases: {id: string}[]}}[]} };
  assert.deepEqual(snapshot.parent_snapshot_ids, [ui, api]);
  assert.deepEqual(snapshot.content.rules.map(row => row.id).sort(), ["behavior", "new-api", "new-ui"]);
  assert.deepEqual(snapshot.content.rules.find(row => row.id === "behavior")!.semantics!.cases.map(item => item.id).sort(), ["api", "old", "ui"]);
  // 遗漏原场景、保留行为、引用无效替代项均阻止写入，并保留旧快照。
  const edit = { ...await input(a, "规格将旧场景改名", 4, idOf(joint)), schema_version: 3 };
  const patch = { upsert_rules: [{ ...rule, semantics: semantics(["renamed", "ui", "api"]) }] };
  const removal = { rule_id: rule.id, kind: "case", id: "old", reason: "规格统一命名", source_id: "code", replacement_id: "renamed" };
  const modify = async (body: object) => a.service.record({ ...edit, patch: body });
  assert.equal((await modify(patch)).code, "PROJECT_MODEL_SCENARIO_MISSING");
  assert.equal((await modify({ upsert_rules: [{ ...rule, semantics: semantics(["old","ui","api"], []) }] })).code, "PROJECT_MODEL_SCENARIO_MISSING");
  for (const invalid of [{ source_id: "missing" }, { replacement_id: "ghost" }])
    assert.equal((await modify({ ...patch, scenario_retirements: [{ ...removal, ...invalid }] })).code, "PROJECT_MODEL_RETIREMENT_INVALID");
  const rename = await modify({ ...patch, scenario_retirements: [removal] });
  assert.equal(rename.code, "PROJECT_MODEL_RECORDED", JSON.stringify(rename));
  const renamed = (await repository.readObject(idOf(rename))).content as {content:{scenario_retirements: unknown[]}};
  assert.deepEqual(renamed.content.scenario_retirements, [removal]);
});

test("工作树来源变化形成稳定复核项，已恢复或被排除的来源不继续提示", async t => {
  const { a, branch, git } = await modelFixture(t), b = await branch("unrelated-work");
  await a.set("edited");
  const first = await readProjectKnowledge(a.binding), second = await readProjectKnowledge(a.binding);
  assert.equal(first.rule_reviews?.items.length, 1);
  const review = first.rule_reviews!.items[0]!;
  assert.equal(review.rule_id, "behavior");
  assert.equal(review.path, sourcePath);
  assert.equal(review.kind, "source");
  assert.ok(review.current_sha256 && review.previous_sha256 !== review.current_sha256);
  assert.deepEqual(first.rule_reviews, second.rule_reviews);
  assert.equal((await readProjectKnowledge(b.binding)).rule_reviews, undefined);
  await b.set("edited");
  assert.notEqual((await readProjectKnowledge(b.binding)).rule_reviews?.items[0]?.review_id, review.review_id);
  await a.set("initial");
  assert.equal((await readProjectKnowledge(a.binding)).rule_reviews, undefined);
  await git(a.binding.root, "mv", sourcePath, "src/renamed-status.js");
  const moved = (await readProjectKnowledge(a.binding)).rule_reviews?.items[0];
  assert.equal(moved?.change, "rename_unresolved");
  assert.equal(moved.path, sourcePath);
  await git(a.binding.root, "mv", "src/renamed-status.js", sourcePath);
  assert.equal((await readProjectKnowledge(a.binding)).rule_reviews, undefined);
  await writeFile(join(a.binding.root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  const changed = await readProjectKnowledge(a.binding);
  const config = changed.rule_reviews?.items.find(item => item.kind === "configuration" && item.path === "tsconfig.json");
  assert.ok(config, JSON.stringify(changed.modules));
  await writeFile(join(a.binding.root, ".project-dev/project.yaml"), `schema_version: 1\nexclude_paths:\n  - ${sourcePath}\n`);
  assert.equal((await readProjectKnowledge(a.binding)).rule_reviews, undefined);
});

test("同文件的证据刷新只解除已复核规则，其余规则仍有独立定位的复核项", async t => {
  const { a, baseline, input } = await modelFixture(t);
  const seed = await input(a, "其他规则也读取相同状态", 1, baseline);
  const result = await a.service.record({ ...seed, patch: {
    upsert_rules: [{ ...seed.patch.upsert_rules[0]!, id: "separate-decision" }] } });
  assert.equal(result.code, "PROJECT_MODEL_RECORDED", JSON.stringify(result));
  await a.set("changed");
  const patch = await input(a, "已重新核对初始规则", 2, (result.data as {snapshot_id: string}).snapshot_id);
  const next = await a.service.record(patch);
  assert.equal(next.code, "PROJECT_MODEL_RECORDED", JSON.stringify(next));
  const knowledge = await readProjectKnowledge(a.binding);
  // 源码HEAD和模型视图可匹配，而同一份模型中未复核的兄弟规则仍使用旧来源版本。
  assert.equal(knowledge.state, "matched");
  assert.deepEqual(knowledge.rule_reviews?.items.map(item => [item.rule_id, item.fingerprint_kind]), [["separate-decision", "source_record"]]);
  const repeat = await readProjectKnowledge(a.binding);
  assert.deepEqual(repeat.rule_reviews, knowledge.rule_reviews);
});
