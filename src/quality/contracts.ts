import { z } from "zod";
import { IdSchema, ReviewSnapshotSchema } from "../domain/common.js";

/** 场景由工具从业务模型生成，Agent 将引用写入现有验收项；不另设用户表单。 */
export const BusinessCheckSchema = z.object({ model_id: IdSchema, rule_id: IdSchema,
  rule_fingerprint: ReviewSnapshotSchema, scenario_id: IdSchema }).strict();
/** 配对评测是维护者可选元数据；未明确标注的任务只参与使用统计，不推断对照组。 */
export const EvaluationTagSchema = z.object({ case_id: IdSchema, variant: z.enum(["baseline", "assisted"]), sample: z.enum(["real", "fixture"]) }).strict();
