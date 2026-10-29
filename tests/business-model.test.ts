import assert from "node:assert/strict";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { TaskService } from "../src/task-service.js";
import { TaskSchema } from "../src/domain/task.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { mapFiles, models, readMap } from "../src/understanding/store.js";
import type { ModelV2, RuleV2 } from "../src/understanding/model-contracts.js";

async function setup(t: { after: (action: () => Promise<void>) => void }) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root), service = new UnderstandingService(binding);
  const tasks = new TaskService(binding);
  const task = TaskSchema.parse((await tasks.open({ requirement: "冻结订单禁止编辑，但允许查看详情。", acceptance_criteria: [{ id: "freeze", description: "冻结后禁止编辑" }] })).data);
  const put = async (path: string, text: string) => { await mkdir(join(binding.root, path, ".."), { recursive: true }); await writeFile(join(binding.root, path), text); };
  await put("src/orders.ts", "export const editable = (state: string) => state !== 'frozen';\n");
  await put("src/detail.ts", "export const visible = true;\n");
  await put("src/submit.ts", "export const submitEnabled = true;\n");
  await put("requirements.md", "冻结订单禁止编辑，但允许查看详情。\n");
  assert.equal((await service.scan({})).outcome, "ok");
  const source = async (id: string, path: string, kind: "code" | "document" = "code") => ({ id, kind, path,
    sha256: (await mapFiles(files)).find((item) => item.path === path)!.sha256, line: 1,
    quote: (await readFile(join(binding.root, path), "utf8")).split("\n")[0]! });
  const rule = (id: string, source_ids: string[], description = "冻结订单不能编辑"): RuleV2 => ({ id, description,
    responsibility: "frontend", basis: "observed", conditions: ["订单处于冻结状态"], exceptions: ["详情查看不受此限制"], source_ids });
  const input = async (id = "orders") => ({ schema_version: 2 as const, id, scan_id: (await readMap(files))!.scan_id, expected_revision: 0,
    revision_reason: "阅读代码并核对冻结状态", module: "orders", title: "订单编辑规则", scope: ["src/orders.ts"], summary: "记录前端编辑限制，后端约束未知。",
    entities: [{ name: "订单", meaning: "有状态的业务单据" }], flows: [{ name: "编辑", steps: ["读取状态", "判定是否允许编辑"] }],
    rules: [rule("edit", ["orders-source"]), rule("edit-label", ["orders-source"], "编辑入口遵循冻结状态限制"), rule("detail", ["detail-source"], "详情仍可查看")],
    sources: [await source("orders-source", "src/orders.ts"), await source("detail-source", "src/detail.ts")],
    related_paths: ["src/orders.ts", "src/detail.ts", "src/submit.ts"], questions: ["后端是否同步限制？"],
    relations: [{ id: "submit-check", rule_ids: ["edit"], kind: "used_by" as const, target_path: "src/submit.ts",
      reason: "提交入口可能使用相同状态，需要核对", source_ids: ["orders-source"] }],
  });
  const detail = async (id = "orders", rule_ids?: string[]) => {
    const result = await service.context({ model_id: id, ...(rule_ids ? { rule_ids } : {}) });
    assert.notEqual(result.outcome, "error", JSON.stringify(result));
    return (result.data as any).models[0];
  };
  const patch = async (revision: number, changes: object, id = "orders") => service.record({ schema_version: 2, id, scan_id: (await readMap(files))!.scan_id,
    expected_revision: revision, revision_reason: "只复核本次相关规则", patch: changes });
  return { fixture, binding, files, service, tasks, task, put, source, rule, input, detail, patch };
}

test("新版模型要求逐条依据、适用条件和有效关系，拒绝伪引用及错误分类", async (t) => {
  const { service, input, source, detail } = await setup(t), model = await input();
  for (const bad of [
    { ...model, rules: [{ ...model.rules[0], source_ids: ["missing"] }] },
    { ...model, relations: [{ ...model.relations[0], rule_ids: ["missing"] }] },
    { ...model, rules: [model.rules[0], model.rules[0]] },
    { ...model, rules: [{ ...model.rules[0], basis: "intended" }] },
    { ...model, sources: [{ ...model.sources[0], kind: "document" }, model.sources[1]] },
    { ...model, sources: [{ ...model.sources[0], quote: "伪造代码" }, model.sources[1]] },
    { ...model, rules: [{ ...model.rules[0], conditions: [] }] },
  ]) assert.equal((await service.record(bad)).outcome, "error");
  const doc = await source("prd", "requirements.md", "document");
  assert.equal((await service.record({ ...model, sources: [...model.sources, doc], related_paths: [...model.related_paths, doc.path],
    rules: [...model.rules, { ...model.rules[0], id: "expected", basis: "intended", source_ids: [doc.id] }] })).outcome, "ok");
  const saved = await detail();
  assert.equal(saved.status, "candidate"); assert.equal(saved.effective, false);
  assert.deepEqual(saved.rules.map((rule: any) => rule.basis), ["observed", "observed", "observed", "intended"]);
  assert.equal(saved.rules[0].freshness, "current");
});

test("局部更新只刷新实际复核规则，共用来源的其他规则和关系保持待核对", async (t) => {
  const { service, files, input, put, source, patch, detail } = await setup(t), model = await input();
  assert.equal((await service.record(model)).outcome, "ok");
  const before = (await models(files))[0] as ModelV2;
  await put("src/orders.ts", "export const editable = (state: string) => !['frozen', 'closed'].includes(state);\n");
  await service.scan({});
  assert.deepEqual((await detail()).review_required.rule_ids, ["edit", "edit-label"]);
  const result = await patch(1, { upsert_sources: [await source("orders-source", "src/orders.ts")], upsert_rules: [{ ...model.rules[0], description: "冻结和关闭订单不能编辑" }] });
  assert.equal(result.outcome, "ok", JSON.stringify(result)); assert.equal((result.data as any).status, "needs_review");
  const saved = (await models(files))[0] as ModelV2, view = await detail();
  assert.deepEqual(saved.rules[1], before.rules[1]); assert.deepEqual(saved.rules[2], before.rules[2]);
  assert.deepEqual(saved.relations[0], before.relations[0]);
  assert.equal(view.rules[0].freshness, "current"); assert.equal(view.rules[1].freshness, "needs_review"); assert.equal(view.rules[2].freshness, "current");
  assert.deepEqual(view.review_required.relation_ids, ["submit-check"]);
  assert.equal((await patch(1, { metadata: { summary: "旧修订不能覆盖" } })).code, "PROJECT_MODEL_REVISION_CONFLICT");
  assert.equal((await patch(2, { upsert_rules: [model.rules[1]], upsert_relations: model.relations })).outcome, "ok");
  assert.equal((await detail()).status, "candidate");
});

test("只修订来源或摘要不会替未检查规则刷新证据，其他文件过期不阻止局部修订", async (t) => {
  const { service, input, put, source, patch, detail, files } = await setup(t);
  const model = await input(); await service.record(model);
  await put("src/orders.ts", "export const editable = false;\n");
  await put("src/detail.ts", "export const visible = false;\n"); await service.scan({});
  assert.equal((await patch(1, { upsert_sources: [await source("orders-source", "src/orders.ts")], metadata: { summary: "发现规则变化，尚未复核全部规则" } })).outcome, "ok");
  let view = await detail(); assert.deepEqual(view.review_required.rule_ids, ["edit", "edit-label", "detail"]);
  assert.equal((await patch(2, { upsert_rules: [model.rules[0]] })).outcome, "ok");
  view = await detail(); assert.deepEqual(view.review_required.rule_ids, ["edit-label", "detail"]);
  assert.equal(view.source_states.find((item: any) => item.path === "src/detail.ts").state, "changed");
  assert.equal((await readdir(join(files.root, ".project-dev/local/understanding/models"))).length, 3);
});

test("局部删除保持引用完整，失败不发布新修订，已有新模型禁止全量覆盖和降级", async (t) => {
  const { service, input, patch, files } = await setup(t), model = await input(); await service.record(model);
  assert.equal((await patch(1, { remove_source_ids: ["orders-source"] })).code, "PROJECT_MODEL_SOURCE_REFERENCE");
  assert.equal((await patch(1, { remove_rule_ids: ["edit"] })).code, "PROJECT_MODEL_RULE_REFERENCE");
  assert.equal((await patch(1, { remove_relation_ids: ["unknown"] })).code, "PROJECT_MODEL_PATCH_INVALID");
  assert.equal((await patch(1, { upsert_rules: [model.rules[0]!], remove_rule_ids: ["edit"] })).code, "PROJECT_MODEL_PATCH_INVALID");
  assert.equal((await patch(1, {})).outcome, "error");
  assert.equal((await service.record({ ...model, expected_revision: 1 })).code, "PROJECT_MODEL_PATCH_REQUIRED");
  assert.equal((await models(files))[0]!.revision, 1);
  assert.equal((await patch(1, { remove_rule_ids: ["edit"], remove_relation_ids: ["submit-check"] })).outcome, "ok");
  assert.equal((await models(files))[0]!.revision, 2);
});

test("任务要求和纠正可作为预期行为依据，不能伪造用户原话或跨工作区引用", async (t) => {
  const { service, input, task, tasks, detail, patch } = await setup(t), model = await input();
  const taskSource = { id: "user-request", kind: "task", task_id: task.id, quote: "冻结订单禁止编辑" };
  const intended = { ...model.rules[0], id: "desired", basis: "intended", source_ids: [taskSource.id] };
  assert.equal((await service.record({ ...model, rules: [intended], relations: [], sources: [{ ...taskSource, quote: "并不存在的确认" }] })).outcome, "error");
  assert.equal((await service.record({ ...model, rules: [intended], relations: [], sources: [taskSource] })).outcome, "ok");
  let view = await detail(); assert.match(view.sources[0].sha256, /^[a-f0-9]{64}$/); assert.equal(view.effective, false);
  const correction = { id: "allow-admin", description: "管理员可以编辑冻结订单", rationale: "补充权限例外", sources: [{ kind: "experience", reference: "当前用户明确修订" }] };
  assert.equal((await tasks.update({ task_id: task.id, expected_revision: 0, corrections: [correction] })).outcome, "ok");
  assert.equal((await patch(1, { upsert_sources: [{ ...taskSource, correction_id: correction.id, quote: correction.description }],
    upsert_rules: [{ ...intended, exceptions: [correction.description] }] })).outcome, "ok");
  assert.equal((await detail()).rules[0].freshness, "current");
  assert.equal((await tasks.update({ task_id: task.id, expected_revision: 1, corrections: [{ ...correction, description: "管理员也不能编辑冻结订单" }] })).outcome, "ok");
  view = await detail(); assert.equal(view.rules[0].freshness, "needs_review");
  const other = await createGitFixture(); t.after(other.cleanup);
  const foreign = TaskSchema.parse((await new TaskService(await bindWorktree(other.path)).open({ requirement: "其他项目要求", acceptance_criteria: [{ id: "x", description: "验证" }] })).data);
  assert.equal((await patch(2, { upsert_sources: [{ ...taskSource, task_id: foreign.id }] })).outcome, "error");
});

test("业务关系支持无 import 的模型检索，规则或关联模型变化会要求复核关系", async (t) => {
  const { service, input, patch, detail, put } = await setup(t);
  const target = { ...await input("status-policy"), module: "policy", title: "状态公共定义", scope: ["src/detail.ts"],
    rules: [{ ...(await input()).rules[2], id: "shared-rule" }], relations: [] };
  assert.equal((await service.record(target)).outcome, "ok");
  const model = await input(); model.relations = [{ ...model.relations[0]!, target_model_id: "status-policy" } as any];
  assert.equal((await service.record(model)).outcome, "ok");
  const page = (await service.context({ modules: ["orders"] })).data as any;
  assert.deepEqual(page.models.map((item: any) => [item.id, item.match_reason]), [["orders", "direct"], ["status-policy", "business_relation"]]);
  assert.equal((await patch(1, { metadata: { summary: "公共规则已有修订" } }, "status-policy")).outcome, "ok");
  assert.equal((await detail()).relations[0].freshness, "needs_review");
  assert.equal((await patch(1, { upsert_relations: model.relations })).outcome, "ok");
  assert.equal((await detail()).relations[0].freshness, "current");
  assert.equal((await patch(2, { upsert_rules: [{ ...model.rules[0], description: "编辑必须满足额外权限" }] })).outcome, "ok");
  assert.equal((await detail()).relations[0].review_reasons[0].state, "rule_needs_review");
  await put(".project-dev/project.yaml", 'schema_version: 1\nexclude_paths:\n  - src/orders.ts\n');
  assert.equal((await service.context({ model_id: "orders" })).code, "PROJECT_MODEL_NOT_FOUND");
});

test("列表默认精简摘要，按规则详情保留条件、异常和依据且报告正确转义", async (t) => {
  const { service, input, detail, files } = await setup(t), model = await input();
  model.rules[0]!.exceptions = ["<script>特殊例外</script>"];
  await service.record(model);
  const page = (await service.context({ paths: ["src/submit.ts"] })).data as any;
  assert.equal(page.models[0].content_truncated, true); assert.equal(page.models[0].sources, undefined);
  assert.equal(page.models[0].rule_count, 3); assert.ok(Buffer.byteLength(JSON.stringify(page.models[0])) < 4_096);
  const selected = await detail("orders", ["edit"]);
  assert.equal(selected.total_rule_count, 3); assert.equal(selected.rules.length, 1); assert.equal(selected.relations.length, 1);
  assert.deepEqual(selected.rules[0].exceptions, model.rules[0]!.exceptions);
  assert.deepEqual(selected.sources.map((item: any) => item.id), ["orders-source"]);
  assert.equal((await service.context({ model_id: "orders", rule_ids: ["missing"] })).code, "PROJECT_MODEL_RULE_NOT_FOUND");
  assert.equal((await service.context({ rule_ids: ["edit"] })).outcome, "error");
  assert.equal((await service.context({ model_id: "orders", model_revision: 99 })).code, "PROJECT_MODEL_REVISION_CONFLICT");
  const report = await files.read(".project-dev/local/understanding/report.html", 65_536);
  assert.ok(report.includes("&lt;script&gt;特殊例外&lt;/script&gt;")); assert.ok(!report.includes("<script>特殊例外</script>"));
});

test("旧模型保持可读，显式补齐依据后迁移且旧版本不可变", async (t) => {
  const { service, input, files, patch, detail } = await setup(t), model = await input();
  const { schema_version, revision_reason, relations, ...body } = model;
  const legacy = { ...body, rules: model.rules.map(({ description, responsibility }) => ({ description, responsibility })),
    sources: model.sources.map(({ id, kind, ...source }) => source) };
  assert.equal((await service.record(legacy)).outcome, "ok");
  assert.equal((await detail()).schema_version, 1);
  const oldFiles = await readdir(join(files.root, ".project-dev/local/understanding/models"));
  const oldBytes = await readFile(join(files.root, ".project-dev/local/understanding/models", oldFiles[0]!));
  assert.equal((await patch(1, { metadata: { summary: "不能自动编造旧规则依据" } })).code, "PROJECT_MODEL_MIGRATION_REQUIRED");
  assert.equal((await service.record({ ...model, expected_revision: 1 })).outcome, "ok");
  assert.equal((await detail()).schema_version, 2);
  assert.deepEqual(await readFile(join(files.root, ".project-dev/local/understanding/models", oldFiles[0]!)), oldBytes);
  assert.equal((await service.record({ ...legacy, expected_revision: 2 })).code, "PROJECT_MODEL_DOWNGRADE");
});

test("索引与业务复核状态分开，重扫不会刷新旧规则或反复要求扫描已删除来源", async (t) => {
  const { service, input, put, detail, binding } = await setup(t); await service.record(await input());
  await put("src/orders.ts", "export const editable = false;\n");
  assert.equal(((await service.context({ model_id: "orders" })).data as any).state, "needs_rescan");
  await service.scan({});
  const result = await service.context({ model_id: "orders" });
  assert.equal(result.outcome, "incomplete"); assert.equal((result.data as any).state, "needs_review");
  assert.deepEqual((await detail()).review_required.rule_ids, ["edit", "edit-label"]);
  await unlink(join(binding.root, "src/orders.ts")); await service.scan({});
  assert.equal(((await service.context({ model_id: "orders" })).data as any).state, "needs_review");
});

test("报告失败仍如实返回已保存修订，避免调用方误认为需要重复写入", async (t) => {
  const { service, input, files, detail } = await setup(t);
  const report = join(files.root, ".project-dev/local/understanding/report.html");
  await unlink(report); await mkdir(report);
  const result = await service.record(await input());
  assert.equal(result.outcome, "ok"); assert.equal(result.diagnostics[0]?.code, "PROJECT_REPORT_UNAVAILABLE");
  assert.equal((await detail()).revision, 1);
});

test("长中文和大量待复核规则仍保持有界摘要及完整分页", async (t) => {
  const { service, input, rule, put } = await setup(t);
  const model = await input();
  const rules = Array.from({ length: 20 }, (_, i) => rule(`r${i}`.padEnd(96, "x"), ["orders-source"], "需要核对的业务规则".repeat(40)));
  for (let i = 0; i < 6; i++) {
    const result = await service.record({ ...model, id: `large-${i}`, title: "业务".repeat(100), module: "模块".repeat(100), summary: "业务背景".repeat(250),
      rules, relations: [] });
    assert.equal(result.outcome, "ok", JSON.stringify(result));
  }
  await put("src/orders.ts", "export const editable = false;\n");
  const first = (await service.context({ paths: ["src/orders.ts"] })).data as any;
  assert.equal(first.models.length, 5); assert.equal(first.next_model_offset, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(first.models)) <= 36_000);
  for (const model of first.models) { assert.ok(Buffer.byteLength(JSON.stringify(model)) < 4_200); assert.equal(model.review_required.rule_count, 20); }
  const second = (await service.context({ paths: ["src/orders.ts"], model_offset: 5 })).data as any;
  assert.equal(second.models.length, 1); assert.equal(second.next_model_offset, null);
});

test("HTML 实现可作为代码依据，不能仅凭文件角色误判为业务文档", async (t) => {
  const { service, input, put, source } = await setup(t);
  await put("src/editor.html", '<button disabled>编辑</button>\n'); await service.scan({});
  const model = await input();
  const result = await service.record({ ...model, sources: [await source("html", "src/editor.html")], related_paths: ["src/editor.html"],
    rules: [{ ...model.rules[0], source_ids: ["html"] }], relations: [] });
  assert.equal(result.outcome, "ok", JSON.stringify(result));
});

test("任务原始需求与名为 requirement 的纠正分别绑定证据，缓存不能串用", async (t) => {
  const { service, input, tasks, task, detail } = await setup(t), model = await input();
  const correction = { id: "requirement", description: "只有管理员可编辑冻结订单", rationale: "补充特殊权限", sources: [{ kind: "experience", reference: "本次用户要求" }] };
  await tasks.update({ task_id: task.id, expected_revision: 0, corrections: [correction] });
  const result = await service.record({ ...model, sources: [
    { id: "original", kind: "task", task_id: task.id, quote: "冻结订单禁止编辑" },
    { id: "corrected", kind: "task", task_id: task.id, correction_id: "requirement", quote: correction.description },
  ], relations: [], rules: [
    { ...model.rules[0], id: "before", basis: "intended", source_ids: ["original"] },
    { ...model.rules[1], id: "after", basis: "intended", source_ids: ["corrected"] },
  ] });
  assert.equal(result.outcome, "ok", JSON.stringify(result));
  const saved = await detail();
  assert.notEqual(saved.sources[0].sha256, saved.sources[1].sha256);
  assert.ok(saved.rules.every((rule: any) => rule.freshness === "current"));
});

test("精确关系只依赖目标规则；无关摘要与规则修订不扩散，术语别名必须有来源", async t => {
  const { service, input, patch, detail } = await setup(t);
  const target = { ...await input("shared"), title: "共享订单规则", relations: [],
    entities: [{ id: "order", name: "订单", meaning: "业务单据", aliases: ["订单单据"], source_ids: ["orders-source"] }] };
  assert.equal((await service.record({ ...target, entities: [{ id: "order", name: "订单", meaning: "业务单据", aliases: ["未经依据的别名"] }] })).code, "PROJECT_MODEL_ENTITY_EVIDENCE");
  assert.equal((await service.record(target)).outcome, "ok");
  const local = await input();
  const relation = { ...local.relations[0]!, target_model_id: "shared", target_rule_ids: ["detail"], target_entity_ids: ["order"] };
  assert.equal((await service.record({ ...local, relations: [{ ...relation, target_rule_ids: ["missing"] }] })).code, "PROJECT_MODEL_TARGET_RULE");
  assert.equal((await service.record({ ...local, relations: [relation] })).outcome, "ok");
  assert.equal((await detail()).relations[0].freshness, "current");
  assert.equal((await patch(1, { metadata: { summary: "只改摘要" } }, "shared")).outcome, "ok");
  assert.equal((await detail()).relations[0].freshness, "current");
  assert.equal((await patch(2, { upsert_rules: [{ ...target.rules[0], description: "无关规则的新解释" }] }, "shared")).outcome, "ok");
  assert.equal((await detail()).relations[0].freshness, "current");
  assert.equal((await patch(3, { upsert_rules: [{ ...target.rules[2], description: "详情行为发生变化" }] }, "shared")).outcome, "ok");
  assert.equal((await detail()).relations[0].freshness, "needs_review");
  const graph = ((await service.context({ model_id: "shared", relation_depth: 2 })).data as any).business_graph;
  assert.ok(graph.edges.some((edge: any) => edge.from_model === "orders" && edge.to_model === "shared"));
  assert.equal(graph.depth, 2);
});
