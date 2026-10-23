import type { WorktreeBinding } from "../git/index.js";
import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import { ProjectFiles } from "../storage/project-files.js";
import { validationRuns } from "./validation-store.js";
import { validationPlanCurrent } from "./validation-plan.js";

/** 文档修改可说明不适用；生产代码不能用空计划绕过真实检查。 */
export const productionPath = (path: string) => !/\.(?:md|mdx|rst|txt|adoc|png|jpe?g|gif|webp|ico|pdf)$/i.test(path)
  && !/(?:^|\/)(?:LICENSE|NOTICE|COPYING)(?:\.[\w-]+)?$/i.test(path);
/** 无法判断权限等状态时保守地视为仍在运行；已死亡的旧启动记录可由后续真实结果恢复。 */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export async function validationReview(binding: WorktreeBinding, task: Task, snapshot: string, changed: string[]) {
  const plan = task.validation_plans?.at(-1), required = task.validation_policy === 1 || !!plan;
  const limitation = "运行记录由本地执行器生成，不能由 task_update 声明通过；同一电脑的文件所有者仍可改写本地资料。代码快照不覆盖忽略依赖、外部服务或运行中改后恢复的瞬时状态。检查成功不等于业务正确。";
  if (!plan) return { state: required && changed.some(productionPath) ? "missing" as const : required ? "not_applicable" as const : "legacy" as const,
    required, checks: [], limitation, reason: required && !changed.some(productionPath) ? "本次无生产代码改动；已有手工验收仍需逐项完成。" : undefined };
  const planCurrent = await validationPlanCurrent(binding, plan);
  if (!plan.plan.checks.length) return { state: changed.some(productionPath) ? "missing" as const : "not_applicable" as const,
    required, checks: [], plan_version: plan.version, reason: plan.plan.not_applicable_reason, limitation };
  const { runs, unfinished, truncated } = await validationRuns(new ProjectFiles(binding.root), task.id);
  // 旧计划中的进程也可能继续修改源码，不能被新计划的成功结果掩盖。
  const active = unfinished.some(item => alive(item.pid));
  const checks = plan.plan.checks.map(check => {
    const candidates = runs.filter(run => run.task_id === task.id && run.repo_identity === binding.repo_identity && run.worktree_path === binding.root
      && run.plan_version === plan.version && run.check_id === check.id).sort((a, b) => b.finished_at.localeCompare(a.finished_at) || b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
    const run = candidates[0];
    const started = unfinished.filter(item => item.check_id === check.id && item.plan_version === plan.version)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    const exact = run && run.command === check.command && JSON.stringify(run.args) === JSON.stringify(check.args) && run.cwd === check.cwd;
    const state = !planCurrent ? "plan_stale" : active || started && (!run || started.started_at >= run.started_at) ? "unfinished" : !run ? "not_run" : !exact || run.start_snapshot !== snapshot || run.end_snapshot !== snapshot ? "stale" : run.state;
    return { id: check.id, description: check.description, acceptance_ids: check.acceptance_ids, state, ...(run ? { run_id: run.id, exit_code: run.exit_code,
      log_reference: `.project-dev/local/validation/${task.id}/${run.id}.json`, output_truncated: run.output_truncated } : {}) };
  });
  return { state: !truncated && checks.every(check => check.state === "passed") ? "checked" as const : "pending" as const,
    required, plan_version: plan.version, checks, truncated, limitation };
}
export function assertValidationReview(review: Awaited<ReturnType<typeof validationReview>>) {
  if (!review.required || ["checked", "not_applicable"].includes(review.state)) return;
  throw new AppError(review.state === "missing" ? "VALIDATION_PLAN_REQUIRED" : "VALIDATION_RUN_REQUIRED",
    "生产代码需保存检查计划并用终端 validation run 执行；未运行、失败、超时或过期的记录不能作为完成证据");
}
