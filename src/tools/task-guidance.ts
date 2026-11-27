/** 只有这个先决条件失败时才建议对应动作，不把一次校验失败当作重新接入项目。 */
const actions = {
  references: ["refresh_references", "task_update", "重新读取报错引用对应的文件和行，核实引用原文、行号和指纹。修正引用或恢复对应源码后再提交。"],
  sources: ["review_requirement_sources", "task_update", "核对需求原文和当前授权的来源，只修正失效的来源条目。"],
  run: ["run_validation", "terminal", "在当前工作树执行已保存计划中的 validation run，再使用与当前快照一致的结果。"],
  plan: ["record_validation_plan", "task_update", "在当前任务保存对应的真实检查计划。"],
  businessPlan: ["record_business_plan", "task_update", "读取 task_check 返回的业务计划问题，在当前任务补充业务规则、影响范围、代码绑定和命名场景，再重新执行 task_check。"],
  businessPlanLate: ["review_late_business_plan", null, "首次业务计划不能在本轮修改之后补交。保留已有改动和任务记录，先核对修改与开工基线，并由开发者决定如何恢复开工顺序；不得自动回滚、丢弃任务或重复提交同一计划。"],
  assessment: ["record_business_assessment", "task_update", "读取当前任务的业务影响和验收范围，在 task_update 中提交 business_assessment；保存后重新核验受影响的验收项。"],
  delta: ["review_business_delta", "project_model_apply", "读取当前任务的业务模型草案、场景和验证结果，补齐 project_model_apply 所需的当前代码依据；绑定未确认前不要重复提交同一草案。"],
  deltaDraft: ["repair_business_delta", "task_update", "先读取当前任务的草案、需求来源和关联验收，用 task_update 单独保存 business_deltas，不要同时关闭任务。场景不足时补齐并关联验收；来源过期时用 supersedes_id 追加有当前依据的修订草案。草案保存并验收后再执行 project_model_apply。"],
  modelBinding: ["refresh_model_bindings", "project_context", "在当前工作树重新读取受影响符号和代码原文，确认唯一声明后再提交业务模型或草案回写。"],
  validationSource: ["repair_validation_plan", "task_update", "读取项目实际脚本和配置，修正 validation_plan 的 source_paths、cwd 或命令后重新保存计划。"],
  validationLimit: ["review_validation_plan_limit", null, "先核对本次限制原因：检查来源超过 40 条时缩小任务范围；任务计划修订已达 10 版时不能再追加计划。保留已有检查、修订与验证记录，由开发者决定拆分或后续处理；不要删除历史或重复提交相同计划。"],
  validationRun: ["rerun_validation", "terminal", "不要复用旧 run_id。按当前任务保存的 validation_plan 重新执行检查，并用同一工作树和结束快照提交结果。"],
  basis: ["record_implementation_basis", "task_update", "读取项目约束和同类实现，记录本次实施依据并关联真实验收项；如已有验收已完成，先按 next_actions 重开后再提交。"],
  review: ["review_snapshot", "task_check", "执行完整 task_check，在返回的当前代码快照上完成指定项的复核。"],
  resume: ["reload_revision", "task_check", "使用 mode:resume 核对当前任务归属及实际修订号，再对照最新任务重提所需修改。"],
  prepare: ["prepare_project", "project_prepare", "用当前 Git 根目录调用 project_prepare(apply:true)。"],
  reload: ["reload_plugin", "plugin_status", "重新打开宿主会话，用 plugin_status 核对运行版本和安装版本。"],
  owner: ["confirm_owner", null, "保留原有归属。只读核对原任务，同一需求可按需求组续接；变更归属须由原会话明确处理。"],
  reopen: ["reopen_acceptance", "task_update", "把列出的验收恢复为 pending，保留其余条目，再提交本次实施依据。"],
  scope: ["review_scope", null, "核对当前工作树与已授权的项目范围。只有用户明确选择时才更改已有范围。"],
  mergeOpen: ["review_merge", null, "核对当前 Git 合并状态。用户已要求处理本次冲突时，在当前工作树以 task_kind:merge_recovery 建任务，按原冲突文件范围处理。"],
  mergeUpdate: ["review_merge", null, "在当前恢复任务内核对原冲突，处理并暂存原冲突文件，再执行检查；需选择业务内容时请用户决定。"],
} as const;
const byCode: Record<string, keyof typeof actions> = {
  IMPLEMENTATION_REFERENCE_INVALID: "references", IMPLEMENTATION_REFERENCE_STALE: "references",
  REQUIREMENT_SOURCE_INVALID: "sources", REQUIREMENT_SOURCE_UNAVAILABLE: "sources", REQUIREMENT_SOURCE_RESERVED: "sources",
  VALIDATION_RUN_REQUIRED: "run", VALIDATION_RUN_INVALID: "validationRun", VALIDATION_PLAN_REQUIRED: "plan",
  VALIDATION_SOURCE_MISSING: "validationSource", VALIDATION_PLAN_LIMIT: "validationLimit",
  BUSINESS_TEST_ADAPTER_COMMAND: "validationSource",
  BUSINESS_PLAN_REQUIRED: "businessPlan", BUSINESS_PLAN_INCOMPLETE: "businessPlan",
  BUSINESS_PLAN_INPUT_PENDING: "businessPlan", BUSINESS_SCENARIO_REQUIRED: "businessPlan",
  BUSINESS_BOUNDARY_VIOLATION: "businessPlan", BUSINESS_PLAN_LATE: "businessPlanLate",
  BUSINESS_PLAN_SCENARIO: "businessPlan", BUSINESS_PLAN_SCENARIO_COVERAGE: "businessPlan",
  BUSINESS_PLAN_SYMBOL_REQUIRED: "businessPlan", BUSINESS_PLAN_BINDING: "businessPlan",
  BUSINESS_PLAN_BINDING_ID: "businessPlan", BUSINESS_PLAN_RELATION_REQUIRED: "businessPlan",
  BUSINESS_PLAN_RELATION_UNRESOLVED: "businessPlan", BUSINESS_PLAN_SOURCE_STALE: "businessPlan",
  BUSINESS_ASSESSMENT_REQUIRED: "assessment", BUSINESS_ASSESSMENT_REVIEW_REQUIRED: "assessment",
  BUSINESS_DELTA_REVIEW_REQUIRED: "delta", BUSINESS_DELTA_BINDINGS: "modelBinding",
  PROJECT_MODEL_BINDING_SOURCE: "modelBinding", PROJECT_MODEL_SOURCE_REFERENCE: "modelBinding",
  PROJECT_MODEL_REVISION_CONFLICT: "modelBinding", PROJECT_MAP_CHANGED: "modelBinding",
  BUSINESS_DELTA_SCENARIO: "deltaDraft", BUSINESS_DELTA_SOURCE_STALE: "deltaDraft",
  REVIEW_SNAPSHOT_REQUIRED: "review", REVIEW_SNAPSHOT_CHANGED: "review", REVIEW_ITEM_INVALID: "review",
  REVIEW_STALE: "review", IMPLEMENTATION_BASIS_REVIEW_REQUIRED: "basis", IMPLEMENTATION_BASIS_REQUIRED: "basis", REVISION_CONFLICT: "resume",
  PROJECT_NOT_ENROLLED: "prepare", PLUGIN_NOT_CONFIGURED: "prepare", PROJECT_SETUP_REQUIRED: "prepare",
  PLUGIN_RELOAD_REQUIRED: "reload", TASK_SESSION_MISMATCH: "owner", TASK_SESSION_REQUIRED: "owner",
  PROJECT_OUTSIDE_WORKSPACE: "scope",
};

/** 不复制宿主权限，不用用户提交的 expected_revision 冒充服务端的当前修订号。 */
export function domainGuidance(name: string, code: string, message: string, facts: Record<string, unknown>) {
  let key = byCode[code];
  // task_update 的草案保存失败时尚无可回写版本；必须先修草案，不能直接发布模型。
  if (code === "BUSINESS_DELTA_REVIEW_REQUIRED" && name === "task_update") key = "deltaDraft";
  if (facts.reference_issues) key = "references";
  if (code === "IMPLEMENTATION_BASIS_REVIEW_REQUIRED" && facts.acceptance_ids) key = "reopen";
  if (code === "UNMERGED_CHANGES") key = name === "task_open" ? "mergeOpen" : "mergeUpdate";
  const [action, tool, instruction] = key ? actions[key] : ["review_error", null, message];
  const retryTool = key === "references" || key === "sources" ? name : tool;
  const issueValues = facts.issues;
  const issues = Array.isArray(issueValues)
    ? issueValues.filter((item): item is string => typeof item === "string").slice(0, 20)
    : undefined;
  const nextActions = [{ action, ...(retryTool ? { tool: retryTool } : {}), instruction }];
  return {
    action, ...(retryTool ? { tool: retryTool } : {}), instruction, retry_same_input: false,
    next_actions: nextActions,
    ...(issues?.length ? { issues } : {}),
    ...(facts.reference_issues ? { reference_issues: facts.reference_issues, verified_reference_ids: facts.verified_reference_ids } : {}),
    ...(facts.acceptance_ids ? { acceptance_ids: facts.acceptance_ids } : {}),
    ...(typeof facts.task_revision === "number" ? { task_revision: facts.task_revision } : {}),
  };
}
