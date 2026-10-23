import { posix } from "node:path";
import type { WorktreeBinding } from "../git/index.js";
import { AppError } from "../domain/error.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { loadConfig } from "../knowledge/config.js";
import { safeSource } from "../understanding/scan.js";
import { ValidationPlanRecordSchema, type ValidationPlanInput, type ValidationPlanRecord } from "./validation-contracts.js";

/** 计划与实际脚本/显式检查配置绑定；参数保持数组，不借 shell 解析用户文本。 */
export async function recordValidationPlan(binding: WorktreeBinding, input: ValidationPlanInput, acceptanceIds: string[], previous?: ValidationPlanRecord) {
  const ids = new Set(input.checks.map(item => item.id));
  if (previous?.plan.checks.some(item => !ids.has(item.id))) throw new AppError("VALIDATION_PLAN_REMOVAL", "已有必需检查不能通过删除计划规避；调整命令后须重新运行");
  if (input.checks.some(item => item.acceptance_ids.some(id => !acceptanceIds.includes(id)))) throw new AppError("VALIDATION_ACCEPTANCE_UNKNOWN", "检查计划只能关联本任务现有验收项");
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const paths = new Set<string>();
  for (const check of input.checks) {
    if (check.cwd !== ".") await files.path(check.cwd);
    for (const path of check.source_paths) paths.add(path);
    // 最近的包声明决定 npm/pnpm/yarn 脚本实际含义，直接 node 检查也保留项目执行声明。
    let directory = check.cwd;
    for (;;) {
      const manifest = directory === "." ? "package.json" : `${directory}/package.json`;
      try { await safeSource(files, manifest, config); paths.add(manifest); break; }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      if (directory === ".") break;
      const parent = posix.dirname(directory); directory = parent === "." ? "." : parent;
    }
  }
  if (paths.size > 40) throw new AppError("VALIDATION_PLAN_LIMIT", "检查配置超过40个来源，请缩小任务范围");
  const source_versions = [];
  for (const path of [...paths].sort()) source_versions.push({ path, sha256: digest(await safeSource(files, path, config)) });
  const version = digest(JSON.stringify(["validation-plan-v1", input, source_versions]));
  return ValidationPlanRecordSchema.parse({ plan: input, source_versions, version, recorded_at: new Date().toISOString() });
}

export async function validationPlanCurrent(binding: WorktreeBinding, plan: ValidationPlanRecord): Promise<boolean> {
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  for (const source of plan.source_versions) {
    try { if (digest(await safeSource(files, source.path, config)) !== source.sha256) return false; }
    catch { return false; }
  }
  return true;
}
