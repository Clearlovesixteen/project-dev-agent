import type { HistoryFinding } from "./history/contracts.js";
import type { MapFile, SavedModel } from "./understanding/contracts.js";

const fileRoles: Record<MapFile["role"], string> = {
  entry: "入口", page: "页面", shared: "共享代码", api: "接口",
  test: "测试", config: "配置", document: "文档", source: "源码",
};

export function fileRoleLabel(role: string): string {
  return Object.hasOwn(fileRoles, role) ? fileRoles[role as MapFile["role"]] : role;
}

export const responsibilityLabels: Record<SavedModel["rules"][number]["responsibility"], string> = {
  frontend: "前端", backend: "后端", shared: "共同负责", unknown: "待确认",
};

export const knowledgeTypeLabels: Record<HistoryFinding["type"], string> = {
  code_convention: "代码约定", business_rule: "业务规则", change_relation: "关联改动",
};
