import { z } from "zod";
import { IdSchema, ReviewSnapshotSchema, RelativePathSchema } from "../domain/common.js";

/** 场景由工具从业务模型生成，Agent 将引用写入现有验收项；不另设用户表单。 */
export const BusinessCheckSchema = z.object({ model_id: IdSchema, rule_id: IdSchema,
  rule_fingerprint: ReviewSnapshotSchema, scenario_id: IdSchema }).strict();
/** 配对评测是维护者可选元数据；未明确标注的任务只参与使用统计，不推断对照组。 */
export const EvaluationTagSchema = z.object({ case_id: IdSchema, variant: z.enum(["baseline", "assisted"]), sample: z.enum(["real", "fixture"]) }).strict();

/** 开始任务时由服务捕获，避免新写的客户端被误认成项目既有规范。 */
export const ImplementationBaselineSchema = z.object({ state: z.enum(["ready", "not_scanned", "unavailable"]),
  scan_id: ReviewSnapshotSchema.optional(), request_entries: z.array(z.object({ path: RelativePathSchema, sha256: ReviewSnapshotSchema }).strict()).max(5),
  truncated: z.boolean() }).strict();

/** 仅在现有封装确实无法满足时，执行者在原清单中记录理由和实际阅读的代码依据。 */
export const ReuseExceptionSchema = z.object({ capability: z.literal("http"), reason: z.string().trim().min(10).max(2000),
  inspected_path: RelativePathSchema, source_version: z.enum(["current", "baseline"]).default("current"),
  sha256: ReviewSnapshotSchema, line: z.number().int().positive(), quote: z.string().trim().min(1).max(1000) }).strict();
