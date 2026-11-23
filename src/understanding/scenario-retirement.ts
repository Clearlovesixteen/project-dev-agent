import { z } from "zod";
import { AppError } from "../domain/error.js";
import { IdSchema } from "../domain/common.js";
import { ShortText } from "./fields.js";
import type { RuleSemantics } from "./semantic-contracts.js";

/** 退役记录定位原场景和需求依据，改名时指明接替它的新场景。 */
export const ScenarioRetirement = z.object({
  rule_id: IdSchema, kind: z.enum(["case", "preserve"]), id: IdSchema,
  reason: ShortText, source_id: IdSchema, replacement_id: IdSchema.optional(),
}).strict();

/** 修改规则时检查遗漏。整条规则的删除另走已有显式退役流程。 */
export function checkScenarioRetirements(ruleId: string, before: readonly RuleSemantics[], after: RuleSemantics | undefined,
  retirements: z.infer<typeof ScenarioRetirement>[], sourceIds: Set<string>) {
  for (const kind of ["case", "preserve"] as const) {
    const field = kind === "case" ? "cases" : "preserves";
    const prior = new Set(before.flatMap(previous => previous[field].map(item => item.id))), next = new Set(after?.[field].map(item => item.id));
    const pending = new Set([...prior].filter(id => !next.has(id)));
    for (const item of retirements.filter(item => item.rule_id === ruleId && item.kind === kind)) {
      if (!pending.delete(item.id) || !sourceIds.has(item.source_id) || item.replacement_id && !next.has(item.replacement_id))
        throw new AppError("PROJECT_MODEL_RETIREMENT_INVALID", `退役或改名需要消失的场景、有效来源和真实替代项：${ruleId}/${kind}/${item.id}`);
    }
    if (pending.size) throw new AppError("PROJECT_MODEL_SCENARIO_MISSING",
      `修订遗漏旧场景：${ruleId}/${kind}/${[...pending].join("、")}。保留场景，或提交 scenario_retirements 说明退役依据`);
  }
}
