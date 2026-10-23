import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { reviewSnapshot } from "../src/git/review-snapshot.js";
import { digest } from "../src/knowledge/document.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { mapFiles, modelIndex, models, readMap } from "../src/understanding/store.js";
import { ruleFingerprint } from "../src/understanding/model-evidence.js";
import type { ModelV2, RuleV2 } from "../src/understanding/model-contracts.js";
import { BusinessDeltaInputSchema } from "../src/quality/business-delta-contracts.js";
import { recordBusinessDeltas, businessDeltaScenarios, businessDeltaReview, applyBusinessDelta, type BusinessDeltaTask } from "../src/quality/business-deltas.js";

async function setup(t: { after(action: () => Promise<void>): void }) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root), service = new UnderstandingService(binding);
  const put = (text: string) => writeFile(join(binding.root, "src/rules.ts"), text);
  await put("export const editable = (state: string) => state !== 'frozen';\nexport const detail = true;\n");
  assert.equal((await service.scan({})).outcome, "ok");
  const code = async (id = "observed-new") => ({ id, kind: "code" as const, path: "src/rules.ts", line: 1,
    sha256: (await mapFiles(files)).find(item => item.path === "src/rules.ts")!.sha256,
    quote: (await readFile(join(binding.root, "src/rules.ts"), "utf8")).split("\n")[0]! });
  const rule: RuleV2 = { id: "edit", description: "冻结订单不能编辑", responsibility: "frontend", basis: "observed", conditions: ["订单处于冻结状态"], exceptions: ["详情查看不受此限制"], source_ids: ["observed-old"] };
  const model = { id: "orders", schema_version: 2, expected_revision: 0, scan_id: (await readMap(files))!.scan_id, revision_reason: "核对当前编辑行为",
    module: "orders", title: "订单编辑", scope: ["src/rules.ts"], summary: "订单可编辑状态与详情展示", entities: [], flows: [], related_paths: ["src/rules.ts"], questions: [],
    rules: [rule, { ...rule, id: "detail", description: "详情始终可查看" }], sources: [await code("observed-old")], relations: [] };
  assert.equal((await service.record(model)).outcome, "ok");
  const task: BusinessDeltaTask = { id: "business-task", repo_identity: binding.repo_identity, worktree_path: binding.root, baseline_head: binding.head, baseline_branch: binding.branch,
    requirement: "冻结和关闭订单不能编辑，详情查看不受此限制。", corrections: [],
    acceptance_criteria: ["normal", "boundary", "exception"].map(id => ({ id, description: `核对业务${id}场景`, status: "pending", evidence: [] })) };
  const draft = () => BusinessDeltaInputSchema.parse({ id: "edit-change", model_id: "orders", base_revision: 1, operation: "modify", rule_id: "edit",
    expected_rule_fingerprint: ruleFingerprint(rule), reason: "新增关闭状态限制", acceptance_ids: ["normal", "boundary", "exception"],
    proposed_rule: { ...rule, basis: "intended", description: "冻结和关闭订单不能编辑", source_ids: ["requirement"] },
    sources: [{ id: "requirement", kind: "task", task_id: task.id, quote: task.requirement }] });
  const record = async (input = draft()) => { task.business_deltas = await recordBusinessDeltas(binding, task, [input]); return task.business_deltas.at(-1)!; };
  const markChecked = async () => {
    const scenarios = businessDeltaScenarios(task.business_deltas!.at(-1)!);
    const snapshot = (await reviewSnapshot(binding, task.baseline_head)).hash;
    task.acceptance_criteria = task.acceptance_criteria.map((item, index) => ({ ...item, status: "checked", reviewed_by: "fixture", review_snapshot: snapshot,
      evidence: [{ kind: "manual", reference: "src/rules.ts", summary: `核验${scenarios[index]!.description}` }], business_delta_check: scenarios[index]!.business_delta_check }));
    return snapshot;
  };
  const implement = async () => { await put("export const editable = (state: string) => !['frozen', 'closed'].includes(state);\nexport const detail = true;\n"); await service.scan({}); };
  const applyInput = async () => ({ delta_id: "edit-change", observed_rule: { ...draft().proposed_rule!, basis: "observed" as const, source_ids: ["observed-new"] }, sources: [await code()] });
  return { fixture, binding, files, service, task, rule, code, draft, record, markChecked, implement, applyInput, put };
}

test("业务草案读取服务端前镜像，预期行为不会提前替换当前模型", async t => {
  const s = await setup(t), before = (await models(s.files))[0];
  const record = await s.record();
  assert.equal(record.before_rule!.description, s.rule.description);
  assert.equal(record.input.proposed_rule!.basis, "intended");
  assert.deepEqual((await models(s.files))[0], before);
  const review = await businessDeltaReview(s.binding, s.task, (await reviewSnapshot(s.binding, s.task.baseline_head)).hash);
  assert.equal(review.items[0]!.state, "pending"); assert.equal(review.items[0]!.scenarios.length, 3);
  const corrupted = { ...s.draft(), expected_rule_fingerprint: "a".repeat(64), id: "wrong" };
  await assert.rejects(recordBusinessDeltas(s.binding, { ...s.task, business_deltas: [] }, [corrupted]), /指纹不一致/);
});

test("草案拒绝伪造需求来源及 observed 预期，不相信未检查的输入", async t => {
  const s = await setup(t);
  await assert.rejects(s.record({ ...s.draft(), sources: [{ ...s.draft().sources[0]!, quote: "用户没有提出的话" }] } as any), /引用原文/);
  assert.equal(BusinessDeltaInputSchema.safeParse({ ...s.draft(), proposed_rule: { ...s.draft().proposed_rule!, basis: "observed" } }).success, false);
  assert.equal(BusinessDeltaInputSchema.safeParse({ ...s.draft(), before_rule: s.rule }).success, false);
});

test("真实代码核验后显式回写 observed，保留无关规则与旧证据，重试幂等", async t => {
  const s = await setup(t); await s.record(); const before = (await models(s.files))[0] as ModelV2;
  await s.implement(); await s.markChecked(); const input = await s.applyInput();
  const receipt = await applyBusinessDelta(s.binding, s.task, input);
  const after = (await models(s.files))[0] as ModelV2;
  assert.equal(after.revision, 2); assert.equal(after.rules[0]!.basis, "observed");
  assert.equal(after.rules[0]!.description, "冻结和关闭订单不能编辑");
  assert.deepEqual(after.rules[1], before.rules[1]);
  assert.deepEqual(await applyBusinessDelta(s.binding, s.task, input), receipt);
  assert.equal((await models(s.files))[0]!.revision, 2);
  assert.equal((await businessDeltaReview(s.binding, s.task, receipt.review_snapshot)).state, "checked");
});

test("验收存在不等于覆盖场景，无关ID和旧草案绑定不能发布", async t => {
  const s = await setup(t); await s.record(); await s.implement();
  await assert.rejects(applyBusinessDelta(s.binding, s.task, await s.applyInput()), /完成关联验收/);
  await s.markChecked(); delete s.task.acceptance_criteria[1]!.business_delta_check;
  await assert.rejects(applyBusinessDelta(s.binding, s.task, await s.applyInput()), /条件边界及例外/);
  await s.markChecked(); s.task.acceptance_criteria[1]!.business_delta_check!.delta_fingerprint = "a".repeat(64);
  await assert.rejects(applyBusinessDelta(s.binding, s.task, await s.applyInput()), /条件边界及例外/);
  assert.equal((await models(s.files))[0]!.revision, 1);
});

test("不能将 intended 直接改标 observed，当前引用和预期一致性分别核对", async t => {
  const s = await setup(t); await s.record(); await s.implement(); await s.markChecked();
  const input = await s.applyInput();
  await assert.rejects(applyBusinessDelta(s.binding, s.task, { ...input, observed_rule: s.draft().proposed_rule }), /独立提交/);
  await assert.rejects(applyBusinessDelta(s.binding, s.task, { ...input, sources: [{ ...input.sources[0]!, sha256: "a".repeat(64) }] }), /哈希一致/);
  await assert.rejects(applyBusinessDelta(s.binding, s.task, { ...input, observed_rule: { ...input.observed_rule, description: "任何订单都可以编辑" } }), /草案预期不同/);
  assert.equal((await models(s.files))[0]!.revision, 1);
});

test("其他规则修订不会覆盖，本规则被并发修改则冲突", async t => {
  const s = await setup(t); await s.record();
  assert.equal((await s.service.record({ id: "orders", schema_version: 2, expected_revision: 1, scan_id: (await readMap(s.files))!.scan_id,
    revision_reason: "补充无关摘要", patch: { metadata: { summary: "其他团队补充的摘要" } } })).outcome, "ok");
  await s.implement(); await s.markChecked(); await applyBusinessDelta(s.binding, s.task, await s.applyInput());
  assert.equal((await models(s.files))[0]!.summary, "其他团队补充的摘要");
  const other = await setup(t); await other.record();
  assert.equal((await other.service.record({ id: "orders", schema_version: 2, expected_revision: 1, scan_id: (await readMap(other.files))!.scan_id,
    revision_reason: "另一个任务修改本规则", patch: { upsert_rules: [{ ...other.rule, description: "管理员可编辑冻结订单" }] } })).outcome, "ok");
  await other.implement(); await other.markChecked();
  await assert.rejects(applyBusinessDelta(other.binding, other.task, await other.applyInput()), /目标规则已变化/);
});

test("发布后回执落盘中断可恢复，改代码后旧回执不能刷新", async t => {
  const s = await setup(t), record = await s.record(); await s.implement(); await s.markChecked();
  const input = await s.applyInput(), receipt = await applyBusinessDelta(s.binding, s.task, input);
  const path = join(s.binding.root, ".project-dev/local/understanding/business-deltas", s.task.id, `${record.fingerprint}.json`);
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.pending = { input_hash: digest(JSON.stringify(input)), marker: ((await models(s.files))[0] as ModelV2).revision_reason, review_snapshot: receipt.review_snapshot, expected_revision: receipt.model_revision };
  delete journal.receipt; journal.receipt_history = []; await writeFile(path, JSON.stringify(journal));
  assert.equal((await applyBusinessDelta(s.binding, s.task, input)).model_revision, 2);
  assert.equal((await models(s.files))[0]!.revision, 2);
  await s.put((await readFile(join(s.binding.root, "src/rules.ts"), "utf8")) + "// 补充边界说明。\n");
  const currentSnapshot = (await reviewSnapshot(s.binding, s.task.baseline_head)).hash;
  assert.equal((await businessDeltaReview(s.binding, s.task, currentSnapshot)).items[0]!.state, "stale");
  await s.markChecked();
  await assert.rejects(applyBusinessDelta(s.binding, s.task, input), /重新扫描|哈希一致/);
  await s.service.scan({}); await s.markChecked();
  const fresh = await applyBusinessDelta(s.binding, s.task, await s.applyInput());
  assert.equal(fresh.review_snapshot, currentSnapshot); assert.equal(fresh.model_revision, 3);
  const finalJournal = JSON.parse(await readFile(path, "utf8"));
  assert.equal(finalJournal.receipt_history.length, 2); assert.equal(finalJournal.receipt_history[0].review_snapshot, receipt.review_snapshot);
  assert.equal((await businessDeltaReview(s.binding, s.task, currentSnapshot)).state, "checked");
});

test("草案修改追加历史，已发布草案保留回执并允许明确后继", async t => {
  const s = await setup(t); const first = await s.record();
  await assert.rejects(s.record({ ...s.draft(), reason: "覆盖原记录" }), /已有草案不能覆盖/);
  const revised = { ...s.draft(), id: "edit-change-2", supersedes_id: "edit-change", reason: "补充实现范围说明" };
  s.task.business_deltas = await recordBusinessDeltas(s.binding, s.task, [revised]);
  assert.equal(s.task.business_deltas.length, 2); assert.deepEqual(s.task.business_deltas[0], first);
  assert.equal((await businessDeltaReview(s.binding, s.task, (await reviewSnapshot(s.binding, s.task.baseline_head)).hash)).items.length, 1);
  const applied = await setup(t); await applied.record(); await applied.implement(); await applied.markChecked(); await applyBusinessDelta(applied.binding, applied.task, await applied.applyInput());
  applied.task.acceptance_criteria = applied.task.acceptance_criteria.map(item => ({ ...item, status: "pending" }));
  const successor = await recordBusinessDeltas(applied.binding, applied.task, [{ ...applied.draft(), id: "replacement", base_revision: 2,
    expected_rule_fingerprint: ruleFingerprint(((await models(applied.files))[0] as ModelV2).rules[0]!), supersedes_id: "edit-change" }]);
  assert.equal(successor.length, 2); assert.deepEqual(successor[0], applied.task.business_deltas![0]);
});

test("删除需退役场景验收，最后规则及未处理关系不被隐式清理", async t => {
  const s = await setup(t), draft = s.draft();
  delete draft.proposed_rule; draft.operation = "remove"; draft.acceptance_ids = ["normal"];
  await s.record(draft); const scenarios = businessDeltaScenarios(s.task.business_deltas![0]!);
  assert.equal(scenarios[0]!.kind, "retirement");
  const snapshot = (await reviewSnapshot(s.binding, s.task.baseline_head)).hash;
  s.task.acceptance_criteria[0] = { ...s.task.acceptance_criteria[0]!, status: "checked", reviewed_by: "fixture", review_snapshot: snapshot,
    evidence: [{ kind: "manual", reference: "src/rules.ts", summary: "核对退役入口及边界" }], business_delta_check: scenarios[0]!.business_delta_check };
  await applyBusinessDelta(s.binding, s.task, { delta_id: draft.id, sources: [await s.code()] });
  assert.deepEqual(((await models(s.files))[0] as ModelV2).rules.map(rule => rule.id), ["detail"]);
  const current = (await models(s.files))[0] as ModelV2;
  const last = { ...draft, id: "last-rule", rule_id: "detail", base_revision: 2, expected_rule_fingerprint: ruleFingerprint(current.rules[0]!) };
  s.task.acceptance_criteria[0]!.status = "pending";
  s.task.business_deltas = await recordBusinessDeltas(s.binding, s.task, [last]);
  s.task.acceptance_criteria[0] = { ...s.task.acceptance_criteria[0]!, status: "checked", business_delta_check: businessDeltaScenarios(s.task.business_deltas.at(-1)!)[0]!.business_delta_check };
  await assert.rejects(applyBusinessDelta(s.binding, s.task, { delta_id: "last-rule", sources: [await s.code()] }), /最后一条规则/);
});

test("新增行为须独立草案和场景，删除有关系引用的规则不会隐式破坏模型", async t => {
  const s = await setup(t), draft = s.draft();
  const added = { ...draft, operation: "add", rule_id: "archive", proposed_rule: { ...draft.proposed_rule!, id: "archive" } } as Record<string, unknown>;
  delete added.expected_rule_fingerprint;
  s.task.business_deltas = await recordBusinessDeltas(s.binding, s.task, [added]);
  assert.equal(s.task.business_deltas[0]!.before_rule, null);
  await s.implement(); await s.markChecked();
  const input = await s.applyInput(); input.observed_rule.id = "archive";
  await applyBusinessDelta(s.binding, s.task, input);
  assert.deepEqual(((await models(s.files))[0] as ModelV2).rules.map(rule => rule.id), ["edit", "detail", "archive"]);
  const other = await setup(t), remove = other.draft(); delete remove.proposed_rule; remove.operation = "remove"; remove.acceptance_ids = ["normal"];
  await other.record(remove);
  assert.equal((await other.service.record({ id: "orders", schema_version: 2, expected_revision: 1, scan_id: (await readMap(other.files))!.scan_id,
    revision_reason: "补充对本规则的业务关系", patch: { upsert_relations: [{ id: "related", rule_ids: ["edit"], kind: "used_by", target_path: "src/rules.ts", reason: "编辑入口依赖", source_ids: ["observed-old"] }] } })).outcome, "ok");
  const scenario = businessDeltaScenarios(other.task.business_deltas![0]!)[0]!;
  other.task.acceptance_criteria[0] = { ...other.task.acceptance_criteria[0]!, status: "checked", reviewed_by: "fixture", review_snapshot: (await reviewSnapshot(other.binding, other.task.baseline_head)).hash,
    evidence: [{ kind: "manual", reference: "src/rules.ts", summary: "核对退役行为" }], business_delta_check: scenario.business_delta_check };
  await assert.rejects(applyBusinessDelta(other.binding, other.task, { delta_id: remove.id, sources: [await other.code()] }), /业务关系引用/);
  assert.equal(((await models(other.files))[0] as ModelV2).relations.length, 1);
});


test("已删除规则在后续代码变化后追加复核回执，不重复删除或丢失原退役历史", async t => {
  const s = await setup(t), draft = s.draft(); delete draft.proposed_rule; draft.operation = "remove"; draft.acceptance_ids = ["normal"];
  const record = await s.record(draft), scenario = businessDeltaScenarios(record)[0]!;
  const checked = async () => { s.task.acceptance_criteria[0] = { ...s.task.acceptance_criteria[0]!, status: "checked", reviewed_by: "fixture",
    review_snapshot: (await reviewSnapshot(s.binding, s.task.baseline_head)).hash,
    evidence: [{ kind: "manual", reference: "src/rules.ts", summary: "重新核对原行为停用和关联入口" }], business_delta_check: scenario.business_delta_check }; };
  await checked(); const first = await applyBusinessDelta(s.binding, s.task, { delta_id: draft.id, sources: [await s.code()] });
  await s.put((await readFile(join(s.binding.root, "src/rules.ts"), "utf8")) + "// 停用行为补充说明。\n"); await s.service.scan({}); await checked();
  const second = await applyBusinessDelta(s.binding, s.task, { delta_id: draft.id, sources: [await s.code()] });
  assert.equal(first.model_revision, second.model_revision); assert.notEqual(first.review_snapshot, second.review_snapshot);
  const journal = JSON.parse(await readFile(join(s.binding.root, ".project-dev/local/understanding/business-deltas", s.task.id, `${record.fingerprint}.json`), "utf8"));
  assert.equal(journal.receipt_history.length, 2); assert.equal((await models(s.files))[0]!.revision, 2);
  assert.equal((await businessDeltaReview(s.binding, s.task, second.review_snapshot)).state, "checked");
});

test("任务纠正变化不会被代码快照掩盖，旧草案需求依据必须重新修订", async t => {
  const s = await setup(t), draft = s.draft();
  s.task.corrections = [{ id: "policy", description: s.task.requirement, rationale: "补充状态规则", sources: [{ kind: "experience", reference: "fixture user correction" }] }];
  draft.sources = [{ id: "requirement", kind: "task", task_id: s.task.id, correction_id: "policy", quote: s.task.requirement }];
  await s.record(draft); await s.implement(); await s.markChecked();
  s.task.corrections[0]!.description = "管理员可以编辑关闭订单";
  await assert.rejects(applyBusinessDelta(s.binding, s.task, await s.applyInput()), /草案需求来源已变化/);
  assert.equal((await models(s.files))[0]!.revision, 1);
});


test("没有草案时不读取全局模型或历史", async t => {
  const s = await setup(t);
  await writeFile(join(s.binding.root, ".project-dev/local/understanding/models.json"), "broken unrelated index");
  assert.deepEqual((await businessDeltaReview(s.binding, s.task, "a".repeat(64))).items, []);
});

test("已发布后新增业务要求可在原任务追加语义后继，旧草案和回执均保留", async t => {
  const s = await setup(t), first = await s.record(); await s.implement(); await s.markChecked();
  const original = await applyBusinessDelta(s.binding, s.task, await s.applyInput());
  const oldReceiptPath = join(s.binding.root, ".project-dev/local/understanding/business-deltas", s.task.id, `${first.fingerprint}.json`);
  const oldJournal = await readFile(oldReceiptPath, "utf8"), current = (await models(s.files))[0] as ModelV2;
  s.task.corrections = [{ id: "new-policy", description: "管理员可以编辑冻结订单，其余关闭和冻结订单不能编辑", rationale: "补充管理员例外", sources: [{ kind: "experience", reference: "fixture user clarification" }] }];
  s.task.acceptance_criteria = ["normal", "boundary", "exception", "admin"].map(id => ({ id, description: `新业务验收 ${id}`, status: "pending", evidence: [] }));
  const next = { ...s.draft(), id: "admin-policy", base_revision: current.revision, supersedes_id: "edit-change",
    expected_rule_fingerprint: ruleFingerprint(current.rules[0]!), acceptance_ids: ["normal", "boundary", "exception", "admin"],
    proposed_rule: { ...s.draft().proposed_rule!, exceptions: ["详情查看不受此限制", "管理员可以编辑冻结订单"] },
    sources: [{ id: "requirement", kind: "task", task_id: s.task.id, correction_id: "new-policy", quote: s.task.corrections[0]!.description }] };
  s.task.business_deltas = await recordBusinessDeltas(s.binding, s.task, [next]);
  await s.put("export const editable = (state: string, admin: boolean) => state !== 'closed' && (state !== 'frozen' || admin);\nexport const detail = true;\n");
  await s.service.scan({}); await s.markChecked();
  const receipt = await applyBusinessDelta(s.binding, s.task, { delta_id: next.id,
    observed_rule: { ...next.proposed_rule, basis: "observed", source_ids: ["observed-successor"] }, sources: [await s.code("observed-successor")] });
  assert.equal(receipt.model_revision, 3); assert.equal(s.task.business_deltas.length, 2);
  assert.equal((await businessDeltaReview(s.binding, s.task, receipt.review_snapshot)).items[0]!.id, next.id);
  assert.equal(await readFile(oldReceiptPath, "utf8"), oldJournal); assert.equal(original.model_revision, 2);
});

test("已退役规则可以明确后继为新增行为，服务确认前镜像不存在", async t => {
  const s = await setup(t), remove = s.draft(); delete remove.proposed_rule; remove.operation = "remove"; remove.acceptance_ids = ["normal"];
  await s.record(remove); const scenario = businessDeltaScenarios(s.task.business_deltas![0]!)[0]!;
  s.task.acceptance_criteria[0] = { ...s.task.acceptance_criteria[0]!, status: "checked", reviewed_by: "fixture", review_snapshot: (await reviewSnapshot(s.binding, s.task.baseline_head)).hash,
    evidence: [{ kind: "manual", reference: "src/rules.ts", summary: "验证旧编辑规则停用" }], business_delta_check: scenario.business_delta_check };
  await applyBusinessDelta(s.binding, s.task, { delta_id: remove.id, sources: [await s.code()] });
  s.task.acceptance_criteria = s.task.acceptance_criteria.map(item => ({ ...item, status: "pending" }));
  const add = { ...s.draft(), id: "reintroduce", operation: "add", base_revision: 2, supersedes_id: remove.id } as Record<string, unknown>; delete add.expected_rule_fingerprint;
  s.task.business_deltas = await recordBusinessDeltas(s.binding, s.task, [add]);
  assert.equal(s.task.business_deltas.at(-1)!.before_rule, null);
});

test("未完成发布不能被新业务草案覆盖，模型标记被无关修订改写仍能恢复旧发布", async t => {
  const s = await setup(t), record = await s.record(); await s.implement(); await s.markChecked(); const input = await s.applyInput();
  const receipt = await applyBusinessDelta(s.binding, s.task, input), model = (await models(s.files))[0] as ModelV2;
  const path = join(s.binding.root, ".project-dev/local/understanding/business-deltas", s.task.id, `${record.fingerprint}.json`);
  const journal = JSON.parse(await readFile(path, "utf8"));
  delete journal.receipt; journal.receipt_history = []; journal.pending = { input_hash: digest(JSON.stringify(input)), marker: model.revision_reason, review_snapshot: receipt.review_snapshot, expected_revision: 2 };
  await writeFile(path, JSON.stringify(journal));
  s.task.acceptance_criteria = s.task.acceptance_criteria.map(item => ({ ...item, status: "pending" }));
  await assert.rejects(recordBusinessDeltas(s.binding, s.task, [{ ...s.draft(), id: "unsafe-next", base_revision: 2, supersedes_id: "edit-change", expected_rule_fingerprint: ruleFingerprint(model.rules[0]!) }]), /未完成发布/);
  assert.equal((await s.service.record({ id: "orders", schema_version: 2, expected_revision: 2, scan_id: (await readMap(s.files))!.scan_id,
    revision_reason: "其他任务更新无关摘要", patch: { metadata: { summary: "不能被恢复流程覆盖的新摘要" } } })).outcome, "ok");
  await s.markChecked(); const recovered = await applyBusinessDelta(s.binding, s.task, input);
  assert.equal(recovered.model_revision, 2); assert.equal((await models(s.files))[0]!.revision, 3);
  assert.equal((await models(s.files))[0]!.summary, "不能被恢复流程覆盖的新摘要");
  assert.equal((await modelIndex(s.files))[0]!.revision, 3);
});
