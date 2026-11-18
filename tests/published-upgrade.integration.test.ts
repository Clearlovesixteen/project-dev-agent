import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { createGitFixture } from "./helpers/create-git-fixture.js";

const sourcePath = "src/project-status.js";
const modelId = "project-status";
const marker = (value: string) => `export const status = "${value}";\n`;

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "pipe" });
}

/** 每棵工作树使用自己的扫描、代码和任务文件，测试只共享实际的 Git 公共目录。 */
async function modelFixture(t: test.TestContext) {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  await writeFile(join(fixture.path, sourcePath), marker("initial"));
  git(fixture.path, "add", "--", sourcePath);
  git(fixture.path, "commit", "-m", "Initial shared status");
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
    git(fixture.path, "worktree", "add", "-b", name, root, "HEAD");
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
  return { fixture, a, branch, baseline, input, settings };
}

test("linked worktree 从常规业务查询直接读取共享模型，冲突复核后各分支继续取得自己的适用模型", async t => {
  const { a, branch, baseline, input, settings } = await modelFixture(t);
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
    git(tree.binding.root, "add", "--", sourcePath);
    git(tree.binding.root, "commit", "-m", "Change branch status");
  }
  const integrationRoot = integration.binding.root;
  git(integrationRoot, "merge", "--no-edit", a.binding.branch!);
  assert.throws(() => git(integrationRoot, "merge", "--no-edit", b.binding.branch!));
  await integration.set("combined");
  git(integrationRoot, "add", "--", sourcePath);
  git(integrationRoot, "commit", "-m", "Review combined status behavior");
  await integration.scan();
  const ambiguous = await integration.context({ model_id: modelId });
  assert.equal(ambiguous.project_knowledge.modules?.[0]?.state, "ambiguous");
  assert.deepEqual(ambiguous.models, []);
  assert.equal((await integration.service.record(await input(integration, "未复核不能认领", 2))).code, "PROJECT_MODEL_REVIEW_REQUIRED");
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
