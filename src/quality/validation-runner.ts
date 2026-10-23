import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { AppError } from "../domain/error.js";
import { TaskStore } from "../storage/task-store.js";
import { ProjectFiles } from "../storage/project-files.js";
import { assertBaseline, assertStateIgnored, type WorktreeBinding } from "../git/index.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { ValidationRunSchema } from "./validation-contracts.js";
import { validationPlanCurrent } from "./validation-plan.js";
import { saveValidationRun, validationRuns } from "./validation-store.js";

/** 只能由 Codex 的原终端执行本 CLI 入口；MCP 查询与更新不会执行项目脚本。 */
export async function runValidation(binding: WorktreeBinding, taskId: string, checkId: string) {
  const store = new TaskStore(binding.root), task = await store.load(taskId);
  if (task.phase !== "active") throw new AppError("TASK_READ_ONLY", "只能执行活跃任务的检查");
  await assertBaseline(binding, task); await assertStateIgnored(binding);
  const plan = task.validation_plans?.at(-1), check = plan?.plan.checks.find(item => item.id === checkId);
  if (!plan || !check) throw new AppError("VALIDATION_PLAN_REQUIRED", "先保存真实检查计划，再选择其中的检查执行");
  if (!await validationPlanCurrent(binding, plan)) throw new AppError("VALIDATION_PLAN_STALE", "检查脚本或配置已变化，请刷新计划后执行");
  const files = new ProjectFiles(binding.root), previous = await validationRuns(files, taskId);
  if (previous.truncated || previous.runs.length >= 100) throw new AppError("VALIDATION_RUN_LIMIT", "本任务已达100次检查运行，请缩小任务范围后继续");
  const cwd = check.cwd === "." ? binding.root : await files.path(check.cwd);
  const snapshot = await reviewSnapshot(binding, task.baseline_head), id = randomUUID(), started_at = new Date().toISOString();
  // 保存启动事实；强制退出来不及生成结果时，没有可供验收采用的成功记录。
  await files.directory(`.project-dev/local/validation/${taskId}`);
  await files.create(`.project-dev/local/validation/${taskId}/${id}.running`, JSON.stringify({ id, task_id: taskId, check_id: checkId, plan_version: plan.version, started_at, pid: process.pid }));
  let output = "", bytes = 0, output_truncated = false;
  const outputHash = createHash("sha256");
  const capture = (chunk: Buffer) => {
    bytes += chunk.length; outputHash.update(chunk);
    output = (output + chunk.toString("utf8")).slice(-16_000);
    if (bytes > 16_000) output_truncated = true;
  };
  const result = await new Promise<{ exit_code: number | null; signal: string | null; state: "passed" | "failed" | "timed_out" | "cancelled" | "start_failed"; error?: string }>(resolve => {
    let timedOut = false, cancelled = false, launchError: string | undefined, killTimer: NodeJS.Timeout | undefined, hardTimer: NodeJS.Timeout | undefined, settled = false;
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(check.command === "node" ? process.execPath : check.command, check.args, { cwd, shell: false,
      env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stop = () => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* 已退出。 */ }
      killTimer ??= setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* 已退出。 */ } }, 500);
      // 脱离进程组的后代可能仍持有管道；到硬截止后关闭本端管道并结算失败，不能无限等 close。
      hardTimer ??= setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(null, null); }, 1000);
    };
    const cancel = () => { cancelled = true; stop(); };
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    const timer = setTimeout(() => { timedOut = true; stop(); }, check.timeout_ms);
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    child.once("error", error => { launchError = error.message.slice(0, 1000); });
    const finish = (exit_code: number | null, signal: string | null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      child.stdout?.removeListener("data", capture); child.stderr?.removeListener("data", capture);
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
      resolve({ exit_code, signal, state: launchError ? "start_failed" : cancelled ? "cancelled" : timedOut ? "timed_out" : exit_code === 0 && !signal ? "passed" : "failed",
        ...(launchError ? { error: launchError } : {}) });
    };
    child.once("close", finish);
  });
  let end_snapshot: string | null = null, current = false;
  try {
    await assertBaseline(binding, task);
    end_snapshot = (await reviewSnapshot(binding, task.baseline_head)).hash;
    const latest = await store.load(taskId);
    current = latest.phase === "active" && latest.validation_plans?.at(-1)?.version === plan.version && await validationPlanCurrent(binding, plan);
  } catch { /* 快照不可读取或任务被中止时，不能认定运行结果可用于当前验收。 */ }
  const state = result.state === "passed" && (!current || end_snapshot !== snapshot.hash) ? "stale" : result.state;
  const run = ValidationRunSchema.parse({ schema_version: 1, id, task_id: taskId, repo_identity: binding.repo_identity, worktree_path: binding.root,
    plan_version: plan.version, check_id: checkId, command: check.command, args: check.args, cwd: check.cwd,
    started_at, finished_at: new Date().toISOString(), start_snapshot: snapshot.hash, end_snapshot,
    ...result, state, output, output_sha256: outputHash.digest("hex"), output_truncated });
  await saveValidationRun(files, run);
  return { outcome: state === "passed" ? "ok" as const : "incomplete" as const, code: state === "passed" ? "VALIDATION_PASSED" : "VALIDATION_NOT_PASSED",
    data: { ...run, log_reference: join(binding.root, `.project-dev/local/validation/${taskId}/${id}.json`) }, diagnostics: [] };
}
