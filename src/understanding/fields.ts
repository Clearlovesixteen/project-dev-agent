import { z } from "zod";
import { RelativePathSchema } from "../domain/common.js";

/** 结构索引和业务模型共用的基础字段，不包含存储或业务推断。 */
export const HASH = z.string().regex(/^[a-f0-9]{64}$/);
export const ShortText = z.string().trim().min(1).max(1_000);
export const ConcretePath = RelativePathSchema.refine((path) => !/[\*?\[\]]/.test(path), "请使用具体的文件或目录路径");
