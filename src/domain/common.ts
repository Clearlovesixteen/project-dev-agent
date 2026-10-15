import { z } from "zod";
import zhCN from "zod/v4/locales/zh-CN.js";

z.config(zhCN());

export const TextSchema = z.string().trim().min(1).max(8_000);
export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const RelativePathSchema = z.string().min(1).max(1_024).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
    && !/^[a-zA-Z]:/.test(value) && value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
  "请使用仓库相对的 POSIX 路径，不能包含路径穿越片段",
);

export const SourceSchema = z.object({
  kind: z.enum(["code", "document", "experience"]),
  reference: TextSchema,
  description: TextSchema.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const EvidenceSchema = z.object({
  kind: z.enum(["code", "test", "manual"]),
  reference: TextSchema,
  summary: TextSchema,
}).strict();

export type Source = z.infer<typeof SourceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
