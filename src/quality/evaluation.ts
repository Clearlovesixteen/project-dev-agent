import type { Task } from "../domain/task.js";
import { digest } from "../knowledge/document.js";

/** 只统计保存的当前事实。纠正条数不等于交互总次数，未记录的返工与测试失败不能推算。 */
export function evaluateTasks(tasks: Task[], truncated = false) {
  const counts = (selected: Task[]) => ({ tasks: selected.length, closed: selected.filter(task => task.phase === "closed").length,
    corrections: selected.reduce((sum, task) => sum + task.corrections.length, 0),
    pending_acceptance: selected.reduce((sum, task) => sum + task.acceptance_criteria.filter(item => item.status !== "checked").length, 0),
    failed_validation_records: selected.reduce((sum, task) => sum + task.validations.filter(item => item.outcome === "failed").length, 0) });
  const groups = new Map<string, Task[]>();
  for (const task of tasks) if (task.evaluation?.sample === "real") {
    const entries = groups.get(task.evaluation.case_id) ?? []; entries.push(task); groups.set(task.evaluation.case_id, entries);
  }
  const pairs = [], excluded = [];
  for (const [case_id, entries] of groups) {
    const baseline = entries.filter(task => task.evaluation!.variant === "baseline"), assisted = entries.filter(task => task.evaluation!.variant === "assisted");
    if (baseline.length !== 1 || assisted.length !== 1) { excluded.push({ case_id, reason: "需要唯一的 baseline 与 assisted 真实样本" }); continue; }
    const a = baseline[0]!, b = assisted[0]!;
    const definition = (task: Task) => digest(JSON.stringify([task.requirement, task.acceptance_criteria.map(item => item.description).sort()]));
    if (a.phase !== "closed" || b.phase !== "closed" || definition(a) !== definition(b)) { excluded.push({ case_id, reason: "样本未完成或需求、验收口径不同" }); continue; }
    pairs.push({ case_id, baseline_task_id: a.id, assisted_task_id: b.id, correction_difference: a.corrections.length - b.corrections.length });
  }
  return { source: "local_task_records", observed: counts(tasks), real_tagged: counts(tasks.filter(task => task.evaluation?.sample === "real")),
    fixture_tasks: tasks.filter(task => task.evaluation?.sample === "fixture").length, unclassified_tasks: tasks.filter(task => !task.evaluation).length,
    comparison: { state: pairs.length && !truncated ? "paired_observations" : "insufficient_data", paired_cases: pairs.length,
      correction_difference: pairs.length && !truncated ? pairs.reduce((sum, pair) => sum + pair.correction_difference, 0) : null,
      pairs: pairs.slice(0, 10), excluded: excluded.slice(0, 10), details_truncated: pairs.length > 10 || excluded.length > 10 }, truncated,
    limitation: "这是当前本地记录统计。无真实同口径配对样本时不计算改善；有配对也只是观察差异，不证明因果。不推算返工工时、未保存的失败次数或遗漏率，fixture 不进入真实效果比较。" };
}
