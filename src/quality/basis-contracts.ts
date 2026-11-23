import { z } from "zod";
import { IdSchema, RelativePathSchema, ReviewSnapshotSchema } from "../domain/common.js";

const Note = z.string().trim().min(1).max(2000);
const Reference = z.object({ id: IdSchema, path: RelativePathSchema, sha256: ReviewSnapshotSchema,
  line: z.number().int().positive(), quote: z.string().trim().min(1).max(1000) }).strict();
const basisFields = {
  references: z.array(Reference).max(12),
  absence_reason: z.string().trim().min(20).max(2000).optional(),
  decisions: z.array(z.object({ id: IdSchema, constraint: Note, implementation: Note,
    reference_ids: z.array(IdSchema).max(12), acceptance_id: IdSchema }).strict()).min(1).max(20),
};

/** MCP 可提交已读原文，由服务计算指纹；明确提交的行号和哈希仍须与原文匹配。 */
const WireFields = z.object({ ...basisFields, references: z.array(Reference.partial({ line: true, sha256: true })).max(12)
  .describe("提交 id、仓库相对 path 和实际阅读的单行 quote，服务可计算 sha256；同一原文出现在多行时必须传 line") }).strict();

/** 在读取文件前拒绝缺失或重复的引用关联；协议层和持久层共用同一规则。 */
function validateLinks(basis: z.infer<typeof WireFields>, ctx: z.RefinementCtx) {
  if (!basis.references.length && !basis.absence_reason) ctx.addIssue({ code: "custom", message: "无可参考实现时必须说明已检索范围及原因" });
  if (basis.references.length && basis.absence_reason) ctx.addIssue({ code: "custom", message: "已有项目引用时不填写无依据原因" });
  for (const key of ["references", "decisions"] as const) {
    if (new Set(basis[key].map(item => item.id)).size !== basis[key].length) ctx.addIssue({ code: "custom", path: [key], message: "实现依据中的 ID 不能重复" });
  }
  const used = new Set(basis.decisions.flatMap(item => item.reference_ids));
  if (basis.decisions.some(item => new Set(item.reference_ids).size !== item.reference_ids.length)
    || [...used].some(id => !basis.references.some(item => item.id === id))
    || basis.references.some(item => !used.has(item.id))) ctx.addIssue({ code: "custom", message: "决策必须引用存在的依据，且每条引用应对应实际决策" });
}
export const WireBasis = WireFields.superRefine(validateLinks);

/** 通用的实现依据需要保存精确行号和指纹，将真实约束与选择接到原有验收流程。 */
export const ImplementationBasisInputSchema = z.object(basisFields).strict().superRefine(validateLinks);

/** 时机、代码指纹和顺序由服务记录；后续修订追加，不覆盖首次依据。 */
export const ImplementationBasisRecordSchema = z.object({ basis: ImplementationBasisInputSchema,
  recorded_at: z.string().datetime({ offset: true }), review_snapshot: ReviewSnapshotSchema,
  timing: z.enum(["before_changes", "after_changes"]) }).strict();
export type ImplementationBasisInput = z.infer<typeof ImplementationBasisInputSchema>;
