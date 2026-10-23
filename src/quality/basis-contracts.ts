import { z } from "zod";
import { IdSchema, RelativePathSchema, ReviewSnapshotSchema } from "../domain/common.js";

const Note = z.string().trim().min(1).max(2000);
/** 通用的实现依据：引用项目原文，将实际约束和实现选择接到原有验收流程。 */
export const ImplementationBasisInputSchema = z.object({
  references: z.array(z.object({ id: IdSchema, path: RelativePathSchema, sha256: ReviewSnapshotSchema,
    line: z.number().int().positive(), quote: z.string().trim().min(1).max(1000) }).strict()).max(12),
  absence_reason: z.string().trim().min(20).max(2000).optional(),
  decisions: z.array(z.object({ id: IdSchema, constraint: Note, implementation: Note,
    reference_ids: z.array(IdSchema).max(12), acceptance_id: IdSchema }).strict()).min(1).max(20),
}).strict().superRefine((basis, ctx) => {
  if (!basis.references.length && !basis.absence_reason) ctx.addIssue({ code: "custom", message: "无可参考实现时必须说明已检索范围及原因" });
  if (basis.references.length && basis.absence_reason) ctx.addIssue({ code: "custom", message: "已有项目引用时不填写无依据原因" });
  for (const key of ["references", "decisions"] as const) {
    if (new Set(basis[key].map(item => item.id)).size !== basis[key].length) ctx.addIssue({ code: "custom", path: [key], message: "实现依据中的 ID 不能重复" });
  }
  const used = new Set(basis.decisions.flatMap(item => item.reference_ids));
  if (basis.decisions.some(item => new Set(item.reference_ids).size !== item.reference_ids.length)
    || [...used].some(id => !basis.references.some(item => item.id === id))
    || basis.references.some(item => !used.has(item.id))) ctx.addIssue({ code: "custom", message: "决策必须引用存在的依据，且每条引用应对应实际决策" });
});

/** 时机、代码指纹和顺序由服务记录；后续修订追加，不覆盖首次依据。 */
export const ImplementationBasisRecordSchema = z.object({ basis: ImplementationBasisInputSchema,
  recorded_at: z.string().datetime({ offset: true }), review_snapshot: ReviewSnapshotSchema,
  timing: z.enum(["before_changes", "after_changes"]) }).strict();
export type ImplementationBasisInput = z.infer<typeof ImplementationBasisInputSchema>;
