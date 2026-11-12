import { z } from "zod";
import { RelativePathSchema } from "./common.js";

const ObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** 冲突恢复授权由服务读取真实 Git 状态建立；调用方只能表达意图和指定来源。 */
export const MergeRecoverySchema = z.object({
  version: z.literal(1), head: ObjectId, merge_head: ObjectId,
  conflicts: z.array(z.object({ path: RelativePathSchema, stages: z.array(z.string().max(140)).min(1).max(3) }).strict()).min(1).max(500),
  source: z.object({ reference: z.string().min(1).max(500), commit: ObjectId }).strict().optional(),
}).strict();
export type MergeRecovery = z.infer<typeof MergeRecoverySchema>;
