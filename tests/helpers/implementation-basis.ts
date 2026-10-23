import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../../src/knowledge/document.js";
import { bindWorktree } from "../../src/git/index.js";
import { TaskStore } from "../../src/storage/task-store.js";
import { runValidation } from "../../src/quality/validation-runner.js";

/** 既有工作流夹具也按新流程读取真实规范，不用伪造依据绕开关闭保护。 */
export async function withImplementationBasis<T extends { acceptance_criteria: { id: string }[] }>(root: string, input: T) {
  const text = await readFile(join(root, "AGENTS.md"), "utf8");
  const line = text.split(/\r?\n/).findIndex(value => value.trim());
  return { ...input, validation_plan: { checks: [{ id: "project-tests", description: "运行样例已有业务测试", command: "node", args: ["--test"], acceptance_ids: [input.acceptance_criteria[0]!.id] }] }, implementation_basis: { references: [{ id: "convention", path: "AGENTS.md", sha256: digest(text), line: line + 1, quote: text.split(/\r?\n/)[line]!.trim() }],
    decisions: [{ id: "scope", constraint: "沿用样例已有职责和约定，落实本次需求", implementation: "在现有职责边界内修改，用本次验收核对实现与要求",
      reference_ids: ["convention"], acceptance_id: input.acceptance_criteria[0]!.id }] } };
}

/** 升级旧工作流回归时也运行真实项目测试，不以夹具自报 passed 绕过新执行保护。 */
export async function runFixtureChecks(root: string, taskId: string) {
  const binding = await bindWorktree(root), task = await new TaskStore(binding.root).load(taskId);
  for (const check of task.validation_plans?.at(-1)?.plan.checks ?? []) {
    const result = await runValidation(binding, taskId, check.id);
    if (result.outcome !== "ok") throw new Error(JSON.stringify(result));
  }
}
