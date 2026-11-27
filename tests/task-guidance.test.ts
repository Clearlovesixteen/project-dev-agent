import assert from "node:assert/strict";
import test from "node:test";
import { domainGuidance } from "../src/tools/task-guidance.js";

test("高频业务校验错误提供明确的恢复工具和下一步", () => {
  const cases = [
    ["BUSINESS_ASSESSMENT_REQUIRED", "record_business_assessment", "task_update"],
    ["BUSINESS_PLAN_SCENARIO", "record_business_plan", "task_update"],
    ["VALIDATION_RUN_INVALID", "rerun_validation", "terminal"],
    ["BUSINESS_DELTA_BINDINGS", "refresh_model_bindings", "project_context"],
    ["PROJECT_MODEL_BINDING_SOURCE", "refresh_model_bindings", "project_context"],
  ] as const;
  for (const [code, action, tool] of cases) {
    const result = domainGuidance("task_update", code, "失败", { issues: ["current_snapshot"] });
    assert.equal(result.action, action, code);
    assert.equal(result.tool, tool, code);
    assert.equal(result.retry_same_input, false, code);
    assert.deepEqual(result.next_actions, [{ action, tool, instruction: result.instruction }], code);
    assert.deepEqual(result.issues, ["current_snapshot"], code);
  }
});

test("引用与来源错误仍按原调用工具重试，并保留结构化定位信息", () => {
  const result = domainGuidance("task_update", "IMPLEMENTATION_REFERENCE_INVALID", "引用失效", {
    reference_issues: [{ index: 0, id: "ref-1", fields: ["line"], reason: "invalid_fields" }],
    verified_reference_ids: ["ref-2"],
  });
  assert.equal(result.action, "refresh_references");
  assert.equal(result.tool, "task_update");
  const data = result as typeof result & { reference_issues: Array<{ id: string }>; verified_reference_ids: string[] };
  assert.equal(data.reference_issues[0]!.id, "ref-1");
  assert.deepEqual(data.verified_reference_ids, ["ref-2"]);
  assert.equal(result.next_actions[0]!.tool, "task_update");
});

// 草案未保存或来源过期时，直接回写模型无法解除错误，应先修订任务草案。
test("草案修复与模型回写按调用阶段给出恢复动作", () => {
  for (const code of ["BUSINESS_DELTA_SCENARIO", "BUSINESS_DELTA_SOURCE_STALE", "BUSINESS_DELTA_REVIEW_REQUIRED"]) {
    const result = domainGuidance("task_update", code, "草案未保存", {});
    assert.equal(result.action, "repair_business_delta", code);
    assert.equal(result.tool, "task_update", code);
    assert.equal(result.retry_same_input, false);
  }
  assert.equal(domainGuidance("project_model_apply", "BUSINESS_DELTA_SOURCE_STALE", "来源变化", {}).tool, "task_update");
  assert.equal(domainGuidance("task_check", "BUSINESS_DELTA_REVIEW_REQUIRED", "待回写", {}).tool, "project_model_apply");
});

// 超过硬限制或补交开工计划需要先核对现状，不能建议无限重复同一写入。
test("不可直接重试的计划错误保留现状并说明限制", () => {
  const late = domainGuidance("task_update", "BUSINESS_PLAN_LATE", "已经修改代码", {});
  assert.equal(late.action, "review_late_business_plan");
  assert.equal(late.tool, undefined);
  assert.match(late.instruction, /不得自动回滚/);
  const limit = domainGuidance("task_update", "VALIDATION_PLAN_LIMIT", "已达修订上限", {});
  assert.equal(limit.action, "review_validation_plan_limit");
  assert.equal(limit.tool, undefined);
  assert.match(limit.instruction, /40/);
  assert.match(limit.instruction, /10/);
});
