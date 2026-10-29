import { z } from "zod";
import { IdSchema } from "../domain/common.js";
import { AppError } from "../domain/error.js";

/** PRD、SDD 和普通需求共用来源/验收结构；标签只说明输入形式，不证明已理解文档。 */
export const SpecificationInput = z.object({
  kind: z.enum(["request", "prd", "sdd", "combined"]),
  source_ids: z.array(IdSchema).min(1).max(20).refine((ids) => new Set(ids).size === ids.length),
}).strict();
export function validateSpecification(input: z.infer<typeof SpecificationInput> | undefined, sourceIds: string[]) {
  if (input?.source_ids.some((id) => !sourceIds.includes(id))) {
    throw new AppError("SPECIFICATION_SOURCE_INVALID", "输入来源需要关联已保存的需求原文或文档版本，不能仅填写 PRD/SDD 标签");
  }
  return input;
}
