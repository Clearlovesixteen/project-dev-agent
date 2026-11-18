import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/index.js";
import { baselineContent } from "../git/workspace-baseline.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { CodeBindingResolver } from "../understanding/code-bindings.js";
import { safeSource } from "../understanding/scan.js";
import { loadSymbolIndex } from "../understanding/load-symbol-index.js";
import { modificationScope } from "./business-plan.js";
import { bindingKey } from "./business-plan-targets.js";
import type { BusinessPlanRecord } from "./business-plan-contracts.js";

/** 基于任务接入内容检查实际差异，工作区已有变动不会被当成本轮越界。 */
export async function businessBoundary(binding: WorktreeBinding, task: Task, record: BusinessPlanRecord, changed: string[]) {
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const scope = modificationScope(record);
  const resolver = new CodeBindingResolver(files, config);
  const issues: { path: string; state: string; symbol?: string }[] = [];
  for (const path of changed) {
    const selectors = scope.get(path);
    if (selectors === undefined || !task.change_items.some(item => item.target_path === path && item.action === "modify")) {
      issues.push({ path, state: selectors === undefined ? "outside_plan" : "modify_checklist_missing" });
      continue;
    }
    try {
      await files.path(path, true);
      if (selectors === null) continue;
      const before = await baselineContent(binding, task.baseline_head, path, task.workspace_baseline);
      const after = await safeSource(files, path, config).catch(error => {
        if (hasCode(error, "ENOENT")) return "";
        throw error;
      });
      const { outsideBindings } = await loadSymbolIndex();
      const oldOutside = outsideBindings(path, before, [...selectors]);
      const newOutside = outsideBindings(path, after, [...selectors]);
      if (!oldOutside || !newOutside || oldOutside !== newOutside) issues.push({ path, state: !oldOutside || !newOutside ? "unsupported_boundary" : "outside_symbols" });
    } catch { issues.push({ path, state: "unreadable_boundary" }); }
  }
  const decisions = new Map(record.input.decisions.map(item => [bindingKey(item), item]));
  for (const target of record.targets) for (const bound of target.bindings) {
    const input = bound.input;
    const action = decisions.get(bindingKey({ ...target, binding_id: input.id }))?.action;
    const context = { path: input.path, ...(input.symbol ? { symbol: input.symbol } : {}) };
    try {
      const current = await resolver.resolve(input);
      if (current.resolution !== "resolved") {
        if (action !== "not_applicable" || changed.includes(input.path)) issues.push({ ...context, state: `binding_${current.resolution}` });
        continue;
      }
      if (action === "modify") continue;
      const unchanged = input.symbol ? current.symbol_sha256 === bound.baseline_symbol_sha256 : current.target_sha256 === bound.baseline_sha256;
      if (!unchanged) issues.push({ ...context, state: "protected_binding_changed" });
    } catch { issues.push({ ...context, state: "binding_unreadable" }); }
  }
  for (const item of record.input.related_checks) if (changed.includes(item.path)) issues.push({ path: item.path, state: "related_read_only_changed" });
  for (const item of record.related_versions) {
    try {
      if ((await resolver.source(item.path)).sha256 !== item.sha256 && !changed.includes(item.path)) issues.push({ path: item.path, state: "related_source_changed" });
    } catch { issues.push({ path: item.path, state: "related_source_unreadable" }); }
  }
  return { state: issues.length ? "pending" as const : "checked" as const, issues, modified_paths: [...scope.keys()] };
}
