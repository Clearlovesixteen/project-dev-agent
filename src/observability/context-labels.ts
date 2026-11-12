import type { DiagnosticContext } from "./diagnostic-context.js";

const fields: Record<string, string> = {
  stage: "判断阶段", decision: "判断结果", native_tool: "宿主工具", command_class: "命令分类", command_family: "能力类别",
  command_shape: "命令结构", shell_dialect: "Shell类型", scope_mode: "接入模式", scope_state: "范围状态",
  enrolled_project_count: "已登记项目数", context_state: "实现上下文", lookup_state: "查询结果状态", task_state: "任务归属/绑定", task_kind: "任务类型", task_phase: "任务阶段",
  baseline_state: "基线状态", basis_state: "实现依据", merge_state: "合并状态", conflict_count: "当前冲突文件数", initial_conflict_count: "恢复任务创建时冲突文件数", target_scope: "目标范围",
  target_count: "本次目标数", planned_count: "计划路径数", recovery_source: "恢复来源", required_action: "建议恢复动作",
  cause_code: "底层原因", node_version: "Node版本", platform: "操作系统", arch: "运行架构",
};
const values: Record<string, string> = {
  runtime: "运行环境", classify: "命令分类", scope: "项目范围", state: "本地状态", context: "实现上下文", task: "任务",
  owner: "会话归属", turn: "当前轮次", baseline: "基线", basis: "实现依据", merge: "合并恢复", target: "目标路径", ready: "就绪",
  validation: "验证", upload: "上传", allow: "允许", deny: "拒绝", skip: "跳过", degraded: "降级", incomplete: "未完成", error: "失败",
  patch: "补丁", edit: "编辑", write: "写入", shell: "终端", project_mcp: "项目MCP", other: "其他", read_only: "只读", unknown: "未知",
  management: "管理操作", git_restore: "Git恢复文件", git_add: "Git暂存", git_read: "Git读取", git_write: "Git修改",
  text_read: "读取文本", number_lines: "按行号读取", search: "搜索", script: "脚本", single: "单条", chain: "命令链",
  pipeline: "管道", redirection: "重定向", dynamic: "动态语法", unconfigured: "未配置", legacy: "旧版配置", projects: "逐项目接入", workspace: "显式工作范围",
  enrolled: "已接入", not_enrolled: "未接入", outside: "范围外", changed: "已变化", invalid: "无效", missing: "缺失", expired: "过期", not_ready: "未就绪",
  not_scanned: "未扫描", paths_excluded: "路径被排除", needs_rescan: "需重新扫描", needs_review: "待复核", indexed: "已索引", partial: "部分结果",
  owned: "当前会话", other_owner: "其他会话", unowned: "无归属记录", not_bound: "未绑定", not_confirmed_this_turn: "本轮未核对",
  development: "普通开发", merge_recovery: "冲突恢复", active: "进行中", suspended: "已挂起", closed: "已关闭", aborted: "已中止",
  valid: "有效", stale: "失效", unmerged: "有未解决冲突", resolved_uncommitted: "已解决、未提交", committed: "已提交", not_merge: "不是merge",
  within: "范围内", unplanned: "未登记计划", selected: "已指定", not_selected: "未指定", matched: "匹配", mismatch: "不匹配",
  prepare: "准备当前项目", query_context: "查询实现上下文", open_task: "建立任务", open_merge_recovery: "建立冲突恢复任务",
  check_task: "恢复/核对任务", review_basis: "重新核对实现依据", plan_paths: "登记修改范围", stage_conflicts: "暂存冲突修复",
  resolve_conflicts: "解决冲突", review_source: "核对指定来源", ask_owner: "确认原会话归属", review_scope: "核对项目范围",
  review_runtime: "核对运行设置", none: "无需恢复动作", darwin: "macOS", win32: "Windows", linux: "Linux",
};

/** 只翻译已采集字段；缺失不补成“通过”，固定关键字段明确显示未观测。 */
export function contextDescription(context: DiagnosticContext | null | undefined) {
  if (!context) return "旧事件或未采集结构化上下文：未知";
  const entries = Object.entries(context).filter(([key]) => key !== "version");
  const observed = new Set(entries.map(([key]) => key));
  return [...entries.map(([key, value]) => `${fields[key] ?? key}：${values[String(value)] ?? String(value)}`),
    ...["stage", "decision"].filter(key => !observed.has(key)).map(key => `${fields[key]}：未观测`)].join("；");
}
