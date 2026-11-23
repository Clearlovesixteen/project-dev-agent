/** 只有这个先决条件失败时才建议对应动作，不把一次校验失败当作重新接入项目。 */
const actions = {
  references: ["refresh_references", "task_update", "重新读取报错引用对应的文件和行，核实引用原文、行号和指纹。修正引用或恢复对应源码后再提交。"],
  sources: ["review_requirement_sources", "task_update", "核对需求原文和当前授权的来源，只修正失效的来源条目。"],
  run: ["run_validation", "terminal", "在当前工作树执行已保存计划中的 validation run，再使用与当前快照一致的结果。"],
  plan: ["record_validation_plan", "task_update", "在当前任务保存对应的真实检查计划。"],
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
  REQUIREMENT_SOURCE_INVALID: "sources", VALIDATION_RUN_REQUIRED: "run", VALIDATION_PLAN_REQUIRED: "plan",
  REVIEW_SNAPSHOT_REQUIRED: "review", REVIEW_SNAPSHOT_CHANGED: "review", REVIEW_ITEM_INVALID: "review",
  REVIEW_STALE: "review", IMPLEMENTATION_BASIS_REVIEW_REQUIRED: "review", REVISION_CONFLICT: "resume",
  PROJECT_NOT_ENROLLED: "prepare", PLUGIN_NOT_CONFIGURED: "prepare", PROJECT_SETUP_REQUIRED: "prepare",
  PLUGIN_RELOAD_REQUIRED: "reload", TASK_SESSION_MISMATCH: "owner", TASK_SESSION_REQUIRED: "owner",
  PROJECT_OUTSIDE_WORKSPACE: "scope",
};

/** 不复制宿主权限，不用用户提交的 expected_revision 冒充服务端的当前修订号。 */
export function domainGuidance(name: string, code: string, message: string, facts: Record<string, unknown>) {
  let key = byCode[code];
  if (facts.reference_issues) key = "references";
  if (code === "IMPLEMENTATION_BASIS_REVIEW_REQUIRED" && facts.acceptance_ids) key = "reopen";
  if (code === "UNMERGED_CHANGES") key = name === "task_open" ? "mergeOpen" : "mergeUpdate";
  const [action, tool, instruction] = key ? actions[key] : ["review_error", null, message];
  const retryTool = key === "references" || key === "sources" ? name : tool;
  return {
    action, ...(retryTool ? { tool: retryTool } : {}), instruction, retry_same_input: false,
    ...(facts.reference_issues ? { reference_issues: facts.reference_issues, verified_reference_ids: facts.verified_reference_ids } : {}),
    ...(facts.acceptance_ids ? { acceptance_ids: facts.acceptance_ids } : {}),
    ...(typeof facts.task_revision === "number" ? { task_revision: facts.task_revision } : {}),
  };
}
