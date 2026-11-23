import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { interactionStorage } from "../src/workflow/interaction.js";
import { TaskSchema } from "../src/domain/task.js";
import { bindWorktree } from "../src/git/index.js";
import { digest } from "../src/knowledge/document.js";
import { businessDeltaScenarios } from "../src/quality/business-deltas.js";
import { runValidation } from "../src/quality/validation-runner.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { TaskService } from "../src/task-service.js";
import { ruleFingerprint } from "../src/understanding/model-evidence.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { models, readMap } from "../src/understanding/store.js";
import type { RuleV3 } from "../src/understanding/model-contracts.js";
import type { BusinessPlan } from "../src/quality/business-plan-contracts.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";

const ruleId = "sync-permission", modelId = "purchase-sync", deltaId = "requested-sync";
const policyFile = "src/purchase-policy.mjs", consumerFile = "src/purchase-list.mjs", testFile = "test/purchase-sync.test.mjs";
const requestQuote = "已完成且未同步或同步失败的采购申请允许同步，未完成的申请禁止同步。";
const preserveQuote = "详情查询行为保持原样。";
const acceptance = ["completed", "draft", "synced", "details"];
const oldPolicy = "export const canSync = (status, syncStatus) => status === 'COMPLETED' && syncStatus === 'NOT_SYNCED';\nexport const detail = () => 'details';\n";
const newPolicy = "export const canSync = (status, syncStatus) => status === 'COMPLETED' && ['NOT_SYNCED', 'FAIL'].includes(syncStatus);\nexport const detail = () => 'details';\n";

function semanticRule(source: string, basis: "intended" | "observed", paths: RuleV3["bindings"], legacy = false): RuleV3 {
  return {
    id: ruleId, description: "采购申请同步权限", responsibility: "frontend", basis,
    conditions: ["申请已完成且同步状态可重试"], exceptions: ["已同步不能再次发起"],
    source_ids: [...new Set([source, ...(paths ?? []).flatMap(item => item.source_ids)])],
    semantics: { subject: "application", action: "sync", expected: "显示同步入口", source_ids: [source],
      when: { all: [{ field: "status", op: "eq", value: "COMPLETED" }, { field: "sync", op: "in", value: legacy ? ["NOT_SYNCED"] : ["NOT_SYNCED", "FAIL"] }] },
      cases: [
        { id: "completed", description: "已完成且可重试的申请允许同步", facts: { status: "COMPLETED", sync: legacy ? "NOT_SYNCED" : "FAIL" }, expected: "allowed", source_ids: [source] },
        { id: "draft", description: "未完成不能同步", facts: { status: "DRAFT", sync: "NOT_SYNCED" }, expected: "denied", source_ids: [source] },
        { id: "synced", description: "同步成功不能重复提交", facts: { status: "COMPLETED", sync: "SUCCESS" }, expected: "denied", source_ids: [source] },
      ], preserves: [{ id: "details", description: preserveQuote, source_ids: [source] }],
    },
    ...(paths ? { bindings: paths } : {}),
  };
}

function tests(existing: boolean, skip = false) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import { canSync } from '../${existing ? consumerFile : policyFile}';
import { detail } from '../${policyFile}';
test('完成的失败申请可以同步', { skip: ${skip} }, () => assert.equal(canSync('COMPLETED', 'FAIL'), true));
test('草稿不能同步', () => assert.equal(canSync('DRAFT', 'NOT_SYNCED'), false));
test('同步成功不可重复', () => assert.equal(canSync('COMPLETED', 'SUCCESS'), false));
test('详情保持可读', () => assert.equal(detail(), 'details'));
`;
}

for (const input of ["sdd", "prd"] as const) test(`${input.toUpperCase()} 贯通原文、范围、真实场景和模型回写`, async t => interactionStorage.run({ session_id: "business-flow-owner" }, async () => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root);
  const service = new TaskService(binding), understanding = new UnderstandingService(binding);
  const existing = input === "sdd";
  const put = async (path: string, content: string) => {
    const absolute = join(binding.root, path);
    await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, content);
  };
  const modelInfo = { module: "purchase", title: "采购同步", scope: ["src"], summary: "采购申请同步权限", entities: [], flows: [], questions: [] };
  const bound = (source: string, planned = false): NonNullable<RuleV3["bindings"]> => [
    { id: "policy", path: policyFile, symbol: "canSync", role: "enforces", source_ids: [source], ...(planned ? { planned: true } : {}) },
    { id: "detail", path: policyFile, symbol: "detail", role: "entry", source_ids: [source === "spec-evidence" ? source : `${source}-detail`], ...(planned ? { planned: true } : {}) },
  ];
  const code = (id: string, text: string, line = 1) => ({ id, kind: "code", path: policyFile, sha256: digest(text), line, quote: text.split("\n")[line - 1] });
  const original = semanticRule("old", "observed", bound("old"), true);
  const retired = { rule_id: ruleId, kind: "case", id: "legacy-sync", reason: "废止旧同步失败场景", source_id: "retirement-spec" };
  const criteriaIds = existing ? [...acceptance, "retired"] : acceptance;
  if (existing) {
    // 原规则多一个旧入口；规格更新需要把该场景的消失纳入真实验收和模型回写。
    original.semantics!.cases.push({ ...original.semantics!.cases[0]!, id: retired.id });
    await put(policyFile, oldPolicy);
    await put(consumerFile, "export { canSync } from './purchase-policy.mjs';\n");
    await understanding.scan({});
    const recorded = await understanding.record({ ...modelInfo, id: modelId, schema_version: 3, scan_id: (await readMap(files))!.scan_id,
      revision_reason: "核对已有同步权限", related_paths: [policyFile, consumerFile], sources: [code("old", oldPolicy), code("old-detail", oldPolicy, 2)], rules: [original],
      relations: [{ id: "list", kind: "used_by", target_path: consumerFile, rule_ids: [ruleId], source_ids: ["old"], reason: "采购列表使用同一个同步权限入口" }] });
    assert.equal(recorded.outcome, "ok", JSON.stringify(recorded));
  }
  const specFile = `.project-dev/local/requirements/purchase-${input}.txt`;
  const spec = `${requestQuote}\n${preserveQuote}\n${existing ? "沿用采购列表已有权限函数。废止旧同步失败场景。\n" : ""}`;
  await put(specFile, spec);
  const { validation_plan, ...open } = await withImplementationBasis(binding.root, {
    requirement: `按附件 ${input.toUpperCase()} 落地采购申请同步功能`, business_model_policy: 1,
    scope_paths: ["src", "test"], spec_input: { kind: input, source_ids: ["spec"] },
    requirement_sources: [{ id: "spec", kind: "document", path: specFile, quote: requestQuote }],
    acceptance_criteria: criteriaIds.map(id => ({ id, description: `核对 ${id}`, requirement_check: { kind: "business", source_ids: ["spec"] } })),
  });
  let task = TaskSchema.parse((await service.open(open)).data);
  const update = async (changes: object, expected = "ok") => {
    const result = await service.update({ task_id: task.id, expected_revision: task.revision, ...changes });
    assert.equal(expected === "ok" ? result.outcome : result.code, expected, JSON.stringify(result));
    if (result.outcome === "ok") task = TaskSchema.parse(result.data);
    return result;
  };
  const quality = async () => ((await service.check({ task_id: task.id })).data as any).quality;
  assert.equal((await quality()).business_plan.state, "missing");
  const draft = semanticRule("spec-evidence", "intended", bound("spec-evidence", !existing));
  const delta = { id: deltaId, model_id: modelId, rule_id: ruleId, base_revision: existing ? 1 : 0,
    ...(existing ? { expected_rule_fingerprint: ruleFingerprint(original) } : { new_model: modelInfo }),
    operation: existing ? "modify" : "add", reason: "按有效文档记录本轮预期行为", acceptance_ids: criteriaIds,
    proposed_rule: draft, sources: [{ id: "spec-evidence", kind: "task", task_id: task.id, requirement_source_id: "spec", quote: requestQuote }] };
  if (existing) await update({ business_deltas: [delta] }, "PROJECT_MODEL_SCENARIO_MISSING");
  await update({ business_deltas: [{ ...delta, ...(existing ? { scenario_retirements: [retired],
    sources: [...delta.sources, { ...delta.sources[0]!, id: retired.source_id, quote: retired.reason }] } : {}) }],
    business_assessment: { state: "changed", reason: "同步权限按有效文档扩展，单独核对详情兼容", model_ids: [modelId], delta_ids: [deltaId] } });
  const stored = task.business_deltas![0]!;
  assert.equal(stored.before_rule === null, !existing);
  assert.equal((await models(files)).length, existing ? 1 : 0);
  const definitions = businessDeltaScenarios(stored);
  const names = ["完成的失败申请可以同步", "草稿不能同步", "同步成功不可重复", "详情保持可读"];
  const plan: BusinessPlan = {
    input_items: [
      { id: "behavior", source_id: "spec", kind: "behavior", quote: requestQuote, acceptance_ids: acceptance.slice(0, 3) },
      { id: "retain", source_id: "spec", kind: "constraint", quote: preserveQuote, acceptance_ids: ["details"] },
    ],
    rules: [{ model_id: modelId, rule_id: ruleId, delta_id: deltaId }],
    decisions: bound("spec-evidence", !existing).map(item => ({ id: item.id, model_id: modelId, rule_id: ruleId, binding_id: item.id,
      action: item.id === "detail" && existing ? "protect" : "modify", reason: "同步权限变化，详情按原要求保留", acceptance_ids: acceptance })),
    related_checks: existing ? [{ path: consumerFile, action: "verify", reason: "列表复用同一个权限入口，核对无需修改", acceptance_ids: ["completed"] }] : [],
    scenarios: definitions.filter(item => item.kind !== "retirement").map((item, index) => ({ id: `case-${index}`, model_id: modelId, rule_id: ruleId,
      ...(item.case_id ? { case_id: item.case_id } : { preserve_id: item.preserve_id! }),
      acceptance_id: acceptance[index]!, check_id: "scenarios", test_file: testFile, test_name: names[index]! })),
    supporting_changes: [{ path: testFile, reason: "用独立命名测试核对业务场景", acceptance_ids: acceptance }],
  };
  const criteria = task.acceptance_criteria.map((item, index) => ({ ...item, business_delta_check: definitions[index]!.business_delta_check }));
  if (existing) await update({ acceptance_criteria: criteria, business_plan: { ...plan, related_checks: [] } }, "BUSINESS_PLAN_RELATION_REQUIRED");
  await update({ acceptance_criteria: criteria, business_plan: { ...plan, input_items: [{ ...plan.input_items[0], quote: "自行增加用户没有写的要求" }, plan.input_items[1]] } }, "BUSINESS_INPUT_QUOTE");
  const changeItems = [policyFile, testFile].map((path, index) => ({ id: `modify-${index}`, action: "modify", target_path: path,
    requirement: "采购同步权限与行为验证", rationale: "改动范围来自已核对的规则与测试", sources: [{ kind: "code", reference: path }], status: "pending" }));
  await update({ acceptance_criteria: criteria, business_plan: plan, change_items: changeItems });
  assert.equal(task.business_plans![0]!.targets[0]!.bindings[0]!.initial.resolution, existing ? "resolved" : "planned");
  // 用同一份已登记计划核对 PRD、SDD 的修改位置。另一会话应得到正常只读摘要与缺口。
  const projection = async () => {
    const result = await understanding.context({ view: "compact", query: "采购同步", task_id: task.id });
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result.data)) <= 12_000);
    return (result.data as any).implementation_view_v1;
  };
  if (!existing) await understanding.scan({});
  const active = await projection();
  assert.ok(active.modify.items.some((item: any) => item.path === policyFile && item.symbol === "canSync"), JSON.stringify(active));
  assert.equal(active.input_kind, input);
  assert.ok(active.verify.items.some((item: any) => item.check_id === "scenarios"));
  if (existing) assert.ok(active.protect.items.some((item: any) => item.symbol === "detail"));
  const other = await interactionStorage.run({ session_id: "unrelated-chat" }, projection);
  assert.deepEqual(other.modify.items, []);
  assert.ok(other.gaps.includes("TASK_SESSION_MISMATCH"));
  await put(specFile, spec + "已修改需求\n");
  assert.equal((await projection()).modify.items.length, 0);
  await put(specFile, spec);
  await put(policyFile, newPolicy + "export const unrelated = 42;\n");
  if (existing) await put(consumerFile, "export const canSync = () => true;\n");
  const bad = (await quality()).business_plan;
  if (existing) assert.ok(bad.advisory.rule_reviews.current_task.some((item: { rule_id: string }) => item.rule_id === ruleId));
  assert.ok(bad.boundary.issues.some((item: any) => item.state === "outside_symbols"), JSON.stringify(bad));
  if (existing) {
    assert.ok(bad.boundary.issues.some((item: any) => item.path === consumerFile && item.state === "outside_plan"));
    await put(consumerFile, "export { canSync } from './purchase-policy.mjs';\n");
  }
  await put(policyFile, newPolicy);
  await put(testFile, tests(existing, true));
  const check = { id: "scenarios", description: "运行采购同步的命名场景", command: "node", args: ["--test", testFile],
    behavior_report: "node-test", acceptance_ids: criteriaIds };
  await update({ validation_plan: { checks: [{ ...check, args: ["-e", "process.exit(0)"] }] } }, "BUSINESS_TEST_ADAPTER_COMMAND");
  await update({ validation_plan: { checks: [check] } });
  const skipped = await runValidation(binding, task.id, check.id);
  assert.equal(skipped.outcome, "ok", JSON.stringify(skipped));
  const pending = (await quality()).business_plan;
  assert.equal(pending.scenarios[0].state, "skipped", JSON.stringify(pending));
  assert.equal((await service.applyBusiness({ task_id: task.id, expected_revision: task.revision, delta_id: deltaId, sources: [code("fresh", newPolicy)] })).code,
    "BUSINESS_PLAN_INCOMPLETE");
  await put(testFile, tests(existing));
  assert.equal((await quality()).business_plan.scenarios[0].state, "plan_stale");
  await update({ validation_plan: { checks: [check] } });
  const run = await runValidation(binding, task.id, check.id);
  assert.equal(run.outcome, "ok", JSON.stringify(run));
  assert.deepEqual((await quality()).business_plan.scenarios.map((item: any) => item.state), acceptance.map(() => "passed"));
  if (existing) {
    // 完整验收可复用同一源码的解析；再次检查前修改受保护代码必须立即失效。
    assert.equal((await quality()).business_plan.boundary.state, "checked");
    await put(policyFile, newPolicy.replace("'details'", "'changed'"));
    assert.ok((await quality()).business_plan.boundary.issues.some((item: any) => item.state === "outside_symbols"));
    await put(policyFile, newPolicy);
  }
  await put(specFile, spec + "需求版本变化\n");
  assert.ok((await quality()).business_plan.issues.includes("input_changed"));
  await put(specFile, spec);
  const token = ((await service.check({ task_id: task.id })).data as any).review_snapshot;
  const checked = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "test", reference: run.data.id, summary: "核对命名测试、代码和项目原文" }] };
  await update({ review_snapshot: token, change_items: task.change_items.map(item => ({ ...item, ...checked })),
    acceptance_criteria: task.acceptance_criteria.map(item => ({ ...item, ...checked })) });
  await understanding.scan({});
  const observed = { ...semanticRule("fresh", "observed", bound("fresh")), description: draft.description };
  const actual = await readFile(join(binding.root, policyFile), "utf8");
  const publication = { task_id: task.id, expected_revision: task.revision, delta_id: deltaId, observed_rule: observed,
    sources: [code("fresh", actual), code("fresh-detail", actual, 2)] };
  const published = await service.applyBusiness(publication);
  assert.equal(published.outcome, "ok", JSON.stringify([published, (await quality()).business_plan]));
  const [model] = await models(files);
  assert.equal(model?.schema_version, 3);
  assert.equal(model?.revision, existing ? 2 : 1);
  assert.equal(model?.rules[0]?.basis, "observed");
  if (existing) {
    assert.deepEqual(model.scenario_retirements, [retired]);
    assert.equal(model.sources.find(source => source.id === retired.source_id)?.kind, "task");
  }
  task = TaskSchema.parse(((await service.check({ task_id: task.id })).data as any).recorded_task);
  const repeated = await service.applyBusiness({ ...publication, expected_revision: task.revision });
  assert.equal(repeated.outcome, "ok", JSON.stringify(repeated));
  assert.equal((await models(files))[0]?.revision, model?.revision);
  task = TaskSchema.parse(((await service.check({ task_id: task.id })).data as any).recorded_task);
  await update({ phase: "closed", review_snapshot: token });
  assert.equal(task.phase, "closed");
}));
