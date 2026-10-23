import { runFixtureChecks, withImplementationBasis } from "./helpers/implementation-basis.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile, symlink, unlink, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { TaskService } from "../src/task-service.js";
import { TaskSchema, type Task } from "../src/domain/task.js";
import { TaskStore } from "../src/storage/task-store.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { mapFiles, models, readMap } from "../src/understanding/store.js";
import { evaluateTasks } from "../src/quality/evaluation.js";
import { auditModels } from "../src/understanding/model-audit.js";

async function setup(t: { after: (action: () => Promise<void>) => void }) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root), tasks = new TaskService(binding), service = new UnderstandingService(binding);
  const task = TaskSchema.parse((await tasks.open(await withImplementationBasis(fixture.path, { requirement: "冻结订单不能编辑，管理员除外", acceptance_criteria: [{ id: "original", description: "按冻结规则开发" }] }))).data);
  const put = async (path: string, text: string) => { await mkdir(join(binding.root, path, ".."), { recursive: true }); await writeFile(join(binding.root, path), text); };
  await put("src/orders.ts", "export const editableOrder = (state: string) => state !== 'frozen';\n");
  await put("src/consumer.ts", "import {editableOrder} from './orders';\nexport const submitOrder = editableOrder;\n");
  await put("src/no-import.ts", "export const orderControl = editableOrder;\n");
  await put("src/detail.ts", "export const renderOrder = true;\n");
  await put("requirements.md", "冻结订单禁止编辑，管理员除外。\n");
  await service.scan({});
  const model = async (id = "orders") => ({ schema_version: 2, id, scan_id: (await readMap(files))!.scan_id, expected_revision: 0, revision_reason: "核对当前依据",
    module: "orders", title: "订单编辑", summary: "前端编辑约束", scope: ["src/orders.ts"], entities: [{ name: "订单", meaning: "有状态的单据" }], flows: [], questions: [],
    related_paths: ["src/orders.ts", "src/detail.ts"], sources: [{ id: "code", kind: "code", path: "src/orders.ts", line: 1,
      quote: (await readFile(join(binding.root, "src/orders.ts"), "utf8")).trim(), sha256: (await mapFiles(files)).find(entry => entry.path === "src/orders.ts")!.sha256 }],
    rules: [{ id: "editable", responsibility: "frontend", basis: "observed", description: "冻结订单不能编辑", conditions: ["订单处于冻结状态"], exceptions: ["管理员除外"], source_ids: ["code"],
      assertion: { subject: "冻结订单", property: "允许编辑", value: "false" } }],
    relations: [{ id: "detail", rule_ids: ["editable"], kind: "used_by", target_path: "src/detail.ts", reason: "详情存在编辑入口", source_ids: ["code"] }] });
  const save = async (input?: object) => { const result = await service.record(input ?? await model()); assert.equal(result.outcome, "ok", JSON.stringify(result)); };
  return { binding, files, tasks, service, task, put, model, save };
}

test("相同条件下断言分歧和明确重复会被发现，不混淆不同范围、职责与例外", async t => {
  const { service, files, model, save } = await setup(t), first = await model(); await save(first);
  await save({ ...first, id: "other", rules: [{ ...first.rules[0]!, assertion: { ...first.rules[0]!.assertion, value: "true" } }] });
  let audit = ((await service.context({ model_id: "orders" })).data as any).model_audit;
  assert.equal(audit.findings[0].kind, "rule_conflict"); assert.equal(audit.effective, false); assert.ok(audit.findings[0].refs[0].details_request.rule_ids);
  const stored = await models(files);
  const sameClaimDifferentBasis = { ...stored[0]!, id: "same-intended", rules: [{ ...stored[0]!.rules[0]!, basis: "intended" }] } as any;
  assert.equal(auditModels([stored[0]!, sameClaimDifferentBasis], new Set(["orders"])).findings.length, 0, "当前行为和需求预期应保留各自性质，不能直接合并");
  const disjoint = { ...stored[1]!, scope: ["other"], related_paths: ["other.ts"] };
  assert.equal(auditModels([stored[0]!, disjoint], new Set(["orders"])).findings.length, 0);
  for (const change of [{ responsibility: "backend" }, { conditions: ["订单已完成"] }, { exceptions: [] }]) {
    const other = { ...stored[1]!, rules: [{ ...stored[1]!.rules[0]!, ...change }] } as any;
    assert.equal(auditModels([stored[0]!, other], new Set(["orders"])).findings.length, 0);
  }
  await save({ ...first, id: "duplicate" });
  audit = ((await service.context({ model_id: "orders" })).data as any).model_audit;
  assert.ok(audit.findings.some((item: any) => item.kind === "duplicate_rule" && item.canonical));
  assert.equal((await models(files)).length, 3, "发现重复不会删除模型或来源");
});

test("需求与代码行为分歧单独提示，术语差异与输出容量保持可解释", async t => {
  const { service, files, model, save } = await setup(t), first = await model(); await save(first);
  const source = (await mapFiles(files)).find(entry => entry.path === "requirements.md")!;
  await save({ ...first, id: "desired", relations: [], related_paths: [...first.related_paths, source.path],
    sources: [{ id: "prd", kind: "document", path: source.path, sha256: source.sha256, line: 1, quote: "冻结订单禁止编辑，管理员除外。" }],
    entities: [{ name: "订单", meaning: "另一种含义需要核对" }], rules: [{ ...first.rules[0]!, basis: "intended", source_ids: ["prd"], assertion: { subject: "冻结订单", property: "允许编辑", value: "true" } }] });
  const audit = ((await service.context({ model_id: first.id })).data as any).model_audit;
  assert.ok(audit.findings.some((item: any) => item.kind === "behavior_divergence"));
  assert.ok(audit.findings.some((item: any) => item.kind === "terminology_collision"));
  assert.equal(audit.requires_semantic_review, true);
  const many = Array.from({ length: 150 }, (_, index) => ({ ...first, id: `copy-${index}`, revision: 1, schema_version: 2 })) as any;
  const bounded = auditModels(many, new Set(many.map((item: any) => item.id)));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 12_000); assert.equal(bounded.truncated, true);
});

test("项目查询与任务检查补充双向引用、同名标识符和业务关系，并核对清单覆盖", async t => {
  const { service, tasks, model, save, task } = await setup(t); await save();
  const result = (await service.context({ paths: ["src/orders.ts"] })).data as any;
  assert.ok(result.impact.candidates.find((item: any) => item.path === "src/consumer.ts").reasons.includes("direct_consumer"));
  assert.ok(result.impact.candidates.find((item: any) => item.path === "src/no-import.ts").reasons.includes("shared_identifier"));
  assert.ok(result.impact.candidates.find((item: any) => item.path === "src/detail.ts").reasons.includes("business_used_by"));
  const change = { id: "orders-change", target_path: "src/orders.ts", action: "modify", requirement: "冻结规则", rationale: "修改源定义", sources: [{ kind: "code", reference: "src/orders.ts" }] };
  await tasks.update({ task_id: task.id, expected_revision: 0, change_items: [change] });
  const checked = (await tasks.check({})).data as any;
  // 实际改动和计划路径均被视为种子，不把已经修改的文件再当成遗漏；尚未改动的关系入口在专用路径查询中可见。
  assert.equal(checked.quality.state, "advisory"); assert.ok(checked.quality.business_checks.total >= 3);
  assert.equal((await model()).rules[0]!.id, "editable");
});

test("业务场景需要当前规则依据、显式绑定和当前代码快照，普通已检查项不能冒充覆盖", async t => {
  const { tasks, task, save, service, files } = await setup(t); await save();
  let checked = (await tasks.check({})).data as any;
  const scenarios = checked.quality.business_checks.scenarios;
  assert.deepEqual(scenarios.map((item: any) => item.kind), ["normal", "boundary", "exception"]);
  assert.ok(scenarios.every((item: any) => item.coverage === "unlinked"));
  const acceptance = [...task.acceptance_criteria, { id: "normal", description: "核对冻结规则正常路径", business_check: scenarios[0].business_check,
    status: "checked", reviewed_by: "fixture", evidence: [{ kind: "test", reference: "fixture:test", summary: "夹具校验" }] }];
  assert.equal((await tasks.update({ task_id: task.id, expected_revision: 0, review_snapshot: checked.review_snapshot, acceptance_criteria: acceptance })).outcome, "ok");
  checked = (await tasks.check({})).data as any;
  assert.equal(checked.quality.business_checks.scenarios[0].coverage, "checked");
  const model = (await models(files))[0]!;
  assert.equal((await service.record({ schema_version: 2, id: model.id, scan_id: model.scan_id, expected_revision: 1, revision_reason: "纠正条件解释",
    patch: { upsert_rules: [{ ...model.rules[0], evidence_versions: undefined, description: "修订冻结规则" }] } })).outcome, "error");
  const { evidence_versions: ignored, ...rule } = model.schema_version === 2 ? model.rules[0]! : (null as never);
  assert.equal((await service.record({ schema_version: 2, id: model.id, scan_id: model.scan_id, expected_revision: 1, revision_reason: "纠正条件解释", patch: { upsert_rules: [{ ...rule, description: "修订冻结规则" }] } })).outcome, "ok");
  checked = (await tasks.check({})).data as any;
  assert.equal(checked.quality.business_checks.scenarios[0].coverage, "stale");
  const evidence = [{ kind: "manual", reference: "fixture", summary: "夹具中的审查依据" }];
  const complete = await tasks.update({ task_id: task.id, expected_revision: 1, review_snapshot: checked.review_snapshot,
    phase: "closed", acceptance_criteria: checked.recorded_task.acceptance_criteria.map((item: any) => item.status === "checked" ? item : ({ ...item, status: "checked", reviewed_by: "fixture", evidence })),
    change_items: checked.changed_paths.map((path: string, index: number) => ({ id: `change-${index}`, target_path: path, action: "modify", requirement: "夹具需求", rationale: "核对实际变更", sources: [{ kind: "code", reference: path }], status: "checked", reviewed_by: "fixture", evidence })) });
  assert.equal(complete.code, "BUSINESS_CHECK_STALE");
});

test("效果统计区分夹具、无对照与真实同口径配对，不凭空宣称提升", async t => {
  const { task } = await setup(t);
  assert.equal(evaluateTasks([task]).comparison.state, "insufficient_data");
  assert.equal(evaluateTasks([task]).comparison.correction_difference, null);
  const review = { reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "fixture", summary: "夹具事实" }] };
  const closed = TaskSchema.parse({ ...task, phase: "closed", acceptance_criteria: task.acceptance_criteria.map(item => ({ ...item, status: "checked", ...review })),
    change_items: [{ id: "change", target_path: "src/service.js", action: "verify", requirement: "夹具验收", rationale: "保证配对样本契约有效", sources: [{ kind: "code", reference: "src/service.js" }], status: "checked", ...review }] });
  const correction = { id: "correction", description: "修正遗漏", rationale: "需求未满足", sources: [{ kind: "experience" as const, reference: "用户反馈" }] };
  const baseline = { ...closed, id: "before", evaluation: { case_id: "same-case", variant: "baseline", sample: "real" }, corrections: [correction] } as Task;
  const assisted = { ...closed, id: "after", evaluation: { case_id: "same-case", variant: "assisted", sample: "real" } } as Task;
  const result = evaluateTasks([baseline, assisted]);
  assert.equal(result.comparison.state, "paired_observations"); assert.equal(result.comparison.correction_difference, 1);
  for (const candidates of [[baseline, { ...assisted, requirement: "不同需求" }], [baseline, { ...assisted, evaluation: { ...assisted.evaluation!, sample: "fixture" as const } }], [baseline, assisted, { ...assisted, id: "retry" }]]) {
    assert.equal(evaluateTasks(candidates).comparison.state, "insufficient_data");
  }
  assert.equal(evaluateTasks([baseline, assisted], true).comparison.correction_difference, null);
});

test("效果统计经 task_check 提供且不写文件；任务列表拒绝链接和其他工作区数据", async t => {
  const { tasks, files, binding, task } = await setup(t);
  const before = await files.read(`.project-dev/local/tasks/${task.id}.json`, 1_000_000);
  const result = (await tasks.check({ include_evaluation: true })).data as any;
  assert.equal(result.evaluation.observed.tasks, 1); assert.equal(result.evaluation.comparison.state, "insufficient_data");
  assert.equal(await files.read(`.project-dev/local/tasks/${task.id}.json`, 1_000_000), before);
  await symlink(join(binding.root, "README.md"), join(binding.root, ".project-dev/local/tasks/unsafe.json"));
  await assert.rejects(() => new TaskStore(binding.root).list());
});

test("增量扫描复用内容，识别等长改写、还原时间戳、新增删除和别名目标", async t => {
  const { service, files, put, binding } = await setup(t);
  await service.scan({}); let map = (await readMap(files))!;
  assert.equal(map.coverage.read_files, 0); assert.equal(map.coverage.content_reused, map.coverage.indexed);
  const path = join(binding.root, "src/detail.ts"), previous = await stat(path);
  await put("src/detail.ts", "export const renderOrder = null;\n"); await utimes(path, previous.atime, previous.mtime);
  await put("src/new.ts", "export const newOrder = true;\n");
  await service.scan({}); map = (await readMap(files))!;
  assert.equal(map.coverage.read_files, 2); assert.ok((await mapFiles(files)).some(entry => entry.path === "src/new.ts"));
  await unlink(join(binding.root, "src/new.ts")); await service.scan({});
  assert.ok(!(await mapFiles(files)).some(entry => entry.path === "src/new.ts"));
  await put("src/aliases.ts", "import {thing} from '@/future';\n");
  await put("tsconfig.json", '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}'); await service.scan({});
  assert.equal((await mapFiles(files)).find(entry => entry.path === "src/aliases.ts")!.imports[0]!.target, null);
  await put("src/future.ts", "export const thing = true;\n"); await service.scan({});
  assert.equal((await mapFiles(files)).find(entry => entry.path === "src/aliases.ts")!.imports[0]!.target, "src/future.ts");
  assert.equal((await readMap(files))!.coverage.read_files, 1);
  await unlink(join(binding.root, "src/orders.ts")); await service.scan({});
  const removed = (await service.context({ paths: ["src/orders.ts"] })).data as any;
  assert.ok(removed.impact.candidates.find((item: any) => item.path === "src/consumer.ts").reasons.includes("unresolved_import_to_changed_path"));
});

test("缓存命中后仍拒绝链接与新出现的嵌套仓库，不绕过来源排除", async t => {
  const { service, files, binding, put } = await setup(t);
  await unlink(join(binding.root, "src/detail.ts")); await symlink("/etc/hosts", join(binding.root, "src/detail.ts"));
  await put("src/.git/config", "");
  assert.equal((await service.scan({})).outcome, "incomplete");
  assert.ok(!(await mapFiles(files)).some(entry => entry.path.startsWith("src/")));
});


test("任务的真实评测分组不能在结果出来后改组，列表截断明确返回", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), service = new TaskService(binding), store = new TaskStore(binding.root);
  const opened = await service.open({ requirement: "真实评测分组契约", acceptance_criteria: [{ id: "criterion", description: "保持口径" }], evaluation: { case_id: "case-one", variant: "assisted", sample: "fixture" } });
  const task = TaskSchema.parse(opened.data);
  await assert.rejects(() => store.update(task.id, 0, current => ({ ...current, evaluation: { ...current.evaluation!, variant: "baseline" } })), /不能事后改组/);
  assert.equal((await store.load(task.id)).revision, 0);
  assert.equal((await store.list(0)).truncated, true);
});

test("显式采用的当前业务场景可以正常关闭任务，不强迫把所有建议都纳入范围", async t => {
  const { tasks, task, save } = await setup(t); await save();
  const checked = (await tasks.check({})).data as any;
  const scenario = checked.quality.business_checks.scenarios[0];
  const review = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "fixture", summary: "核对指定业务场景" }] };
  await runFixtureChecks(task.worktree_path, task.id);
  const result = await tasks.update({ task_id: task.id, expected_revision: 0, review_snapshot: checked.review_snapshot, phase: "closed",
    acceptance_criteria: [...task.acceptance_criteria.map(item => ({ ...item, ...review })), { id: "business-normal", description: "核对正常路径", business_check: scenario.business_check, ...review }],
    change_items: checked.changed_paths.map((path: string, index: number) => ({ id: `change-${index}`, target_path: path, action: "modify", requirement: "夹具需求", rationale: "核对变更", sources: [{ kind: "code", reference: path }], ...review })) });
  assert.equal(result.outcome, "ok", JSON.stringify(result));
  assert.equal((result.data as any).phase, "closed");
  const historical = (await tasks.check({ task_id: task.id, include_evaluation: true })).data as any;
  assert.equal(historical.evaluation.observed.closed, 1);
});


test("同场景存在新旧两个验收项时，不能用新的有效项掩盖旧指纹", async t => {
  const { tasks, task, save } = await setup(t); await save();
  const checked = (await tasks.check({})).data as any;
  const business_check = checked.quality.business_checks.scenarios[0].business_check;
  const review = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "fixture", summary: "夹具中的同场景验收" }] };
  const result = await tasks.update({ task_id: task.id, expected_revision: 0, review_snapshot: checked.review_snapshot, phase: "closed",
    acceptance_criteria: [...task.acceptance_criteria.map(item => ({ ...item, ...review })),
      { id: "current", description: "当前规则验收", business_check, ...review },
      { id: "stale", description: "旧规则验收", business_check: { ...business_check, rule_fingerprint: "0".repeat(64) }, ...review }],
    change_items: checked.changed_paths.map((path: string, index: number) => ({ id: `change-${index}`, target_path: path, action: "modify", requirement: "夹具需求", rationale: "核对变更", sources: [{ kind: "code", reference: path }], ...review })) });
  assert.equal(result.code, "BUSINESS_CHECK_STALE");
});

test("移除来源后已重扫的任务检查不会要求反复重扫", async t => {
  const { tasks, service, binding } = await setup(t);
  await unlink(join(binding.root, "src/detail.ts"));
  await service.scan({});
  const result = (await tasks.check({})).data as any;
  assert.equal(result.quality.index_state, "current");
});


test("同次关闭时修改任务来源的纠正，必须按即将保存的内容核验业务依据", async t => {
  const { tasks, task, service, model, save } = await setup(t);
  const correction = { id: "admin", description: "管理员除外", rationale: "明确权限例外", sources: [{ kind: "experience", reference: "夹具用户要求" }] };
  assert.equal((await tasks.update({ task_id: task.id, expected_revision: 0, corrections: [correction] })).outcome, "ok");
  const input = await model();
  await save({ ...input, relations: [], sources: [{ id: "request", kind: "task", task_id: task.id, correction_id: correction.id, quote: correction.description }],
    rules: [{ ...input.rules[0]!, basis: "intended", source_ids: ["request"] }] });
  const checked = (await tasks.check({})).data as any;
  const business_check = checked.quality.business_checks.scenarios[0].business_check;
  const review = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "fixture", summary: "核对关闭时来源" }] };
  const result = await tasks.update({ task_id: task.id, expected_revision: 1, review_snapshot: checked.review_snapshot, phase: "closed",
    corrections: [{ ...correction, description: "管理员也不例外" }],
    acceptance_criteria: [...task.acceptance_criteria.map(item => ({ ...item, ...review })), { id: "business", description: "核对权限例外", business_check, ...review }],
    change_items: checked.changed_paths.map((path: string, index: number) => ({ id: `change-${index}`, target_path: path, action: "modify", requirement: "夹具需求", rationale: "核对变更", sources: [{ kind: "code", reference: path }], ...review })) });
  assert.equal(result.code, "BUSINESS_CHECK_STALE");
  const current = (await tasks.check({})).data as any;
  assert.equal(current.phase, "active"); assert.equal(current.recorded_task.corrections[0].description, correction.description);
  assert.equal((await service.context({ model_id: input.id })).outcome, "ok");
});
