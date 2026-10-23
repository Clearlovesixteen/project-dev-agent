import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../../src/knowledge/document.js";

/** 既有工作流夹具也按新流程读取真实规范，不用伪造依据绕开关闭保护。 */
export async function withImplementationBasis<T extends { acceptance_criteria: { id: string }[] }>(root: string, input: T) {
  const text = await readFile(join(root, "AGENTS.md"), "utf8");
  const line = text.split(/\r?\n/).findIndex(value => value.trim());
  return { ...input, implementation_basis: { references: [{ id: "convention", path: "AGENTS.md", sha256: digest(text), line: line + 1, quote: text.split(/\r?\n/)[line]!.trim() }],
    decisions: [{ id: "scope", constraint: "沿用样例已有职责和约定，落实本次需求", implementation: "在现有职责边界内修改，用本次验收核对实现与要求",
      reference_ids: ["convention"], acceptance_id: input.acceptance_criteria[0]!.id }] } };
}
