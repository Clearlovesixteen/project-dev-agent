import { z } from "zod";
import { TextSchema } from "./common.js";

export const DiagnosticSchema = z.object({
  code: TextSchema,
  message: TextSchema,
  reference: TextSchema.optional(),
}).strict();

export const ToolResultSchema = z.object({
  outcome: z.enum(["ok", "incomplete", "error"]),
  code: TextSchema,
  data: z.unknown().optional(),
  diagnostics: z.array(DiagnosticSchema).max(100).default([]),
}).strict().superRefine((result, ctx) => {
  if (result.outcome !== "ok" && result.diagnostics.length === 0) {
    ctx.addIssue({ code: "custom", path: ["diagnostics"], message: "执行未完成或失败时，必须说明原因" });
  }
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
