import { z } from "zod";
import { RelativePathSchema, ReviewSnapshotSchema } from "./common.js";

/** 服务捕获接入时的有效内容；不保存或重放 Git index，不改开发者的暂存状态。 */
export const WorkspaceEntrySchema = z
  .object({
    path: RelativePathSchema,
    kind: z.enum(["file", "missing", "symlink"]),
    sha256: ReviewSnapshotSchema.optional(),
    mode: z.number().int().optional(),
    target: z.string().max(4096).optional(),
    chunks: z.array(ReviewSnapshotSchema).max(16).optional(),
  })
  .strict();
export const WorkspaceBaselineSchema = z
  .object({
    version: z.literal(1),
    snapshot: ReviewSnapshotSchema,
    entries: z.array(WorkspaceEntrySchema).max(2000),
  })
  .strict();
export type WorkspaceBaseline = z.infer<typeof WorkspaceBaselineSchema>;
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
