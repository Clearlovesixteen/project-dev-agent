import { z } from "zod";
import { IdSchema } from "../domain/common.js";
import { ConcretePath, HASH, ShortText } from "./fields.js";

const Scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;
const Field = z.string().min(1).max(160).regex(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/)
  .refine(value => !value.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part)), "条件字段不能访问原型");
export type Predicate = { field: string; op: "eq" | "neq" | "in" | "not_in" | "exists" | "gt" | "gte" | "lt" | "lte"; value?: Scalar | Scalar[] | undefined }
  | { all: Predicate[] } | { any: Predicate[] } | { not: Predicate };
const PredicateNode: z.ZodType<Predicate> = z.lazy(() => z.union([
  z.object({ field: Field, op: z.enum(["eq", "neq", "in", "not_in", "exists", "gt", "gte", "lt", "lte"]), value: z.union([Scalar, z.array(Scalar).min(1).max(20)]).optional() }).strict(),
  z.object({ all: z.array(PredicateNode).min(1).max(20) }).strict(),
  z.object({ any: z.array(PredicateNode).min(1).max(20) }).strict(),
  z.object({ not: PredicateNode }).strict(),
]));
/** 在递归契约前限深与限量；模型内容只是数据，不能执行表达式或调用项目代码。 */
export const RulePredicate = z.unknown().superRefine((value, context) => {
  let nodes = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++nodes > 60 || depth > 5 || !node || typeof node !== "object" || Array.isArray(node)) return false;
    const record = node as Record<string, unknown>;
    return Object.entries(record).every(([key, child]) => !["all", "any", "not"].includes(key)
      || (key === "not" ? visit(child, depth + 1) : Array.isArray(child) && child.every(item => visit(item, depth + 1))));
  };
  if (!visit(value, 0)) context.addIssue({ code: "custom", message: "业务条件超过深度或数量限制" });
}).pipe(PredicateNode).superRefine((value, context) => {
  const visit = (node: Predicate) => {
    if ("all" in node) return node.all.forEach(visit);
    if ("any" in node) return node.any.forEach(visit);
    if ("not" in node) return visit(node.not);
    if (node.op !== "exists" && node.value === undefined || ["in", "not_in"].includes(node.op) && !Array.isArray(node.value)
      || ["gt", "gte", "lt", "lte"].includes(node.op) && typeof node.value !== "number"
      || ["eq", "neq"].includes(node.op) && Array.isArray(node.value)
      || node.op === "exists" && node.value !== undefined)
      context.addIssue({ code: "custom", message: "条件操作符与值类型不匹配" });
  }; visit(value);
});
export const RuleSemantics = z.object({
  subject: IdSchema, action: IdSchema, when: RulePredicate,
  expected: ShortText,
  preserves: z.array(z.object({ id: IdSchema, description: ShortText, source_ids: z.array(IdSchema).min(1).max(10) }).strict()).max(10),
  cases: z.array(z.object({ id: IdSchema, description: ShortText,
    facts: z.record(Field, Scalar).refine(value => Object.keys(value).length <= 30, "每个场景最多 30 个事实"), expected: z.enum(["allowed", "denied", "unknown"]),
    source_ids: z.array(IdSchema).min(1).max(10),
  }).strict()).max(20),
  source_ids: z.array(IdSchema).min(1).max(10),
}).strict();
export type RuleSemantics = z.infer<typeof RuleSemantics>;

export const CodeBindingInput = z.object({ id: IdSchema, path: ConcretePath,
  symbol: z.string().trim().min(1).max(180).optional(),
  role: z.enum(["entry", "enforces", "consumer", "contract", "reuse", "test"]),
  source_ids: z.array(IdSchema).min(1).max(10), planned: z.boolean().optional(),
}).strict();
export const SavedCodeBinding = CodeBindingInput.extend({
  resolution: z.enum(["resolved", "planned", "ambiguous", "missing", "unsupported"]),
  target_sha256: HASH.nullable(), symbol_sha256: HASH.nullable(),
  start: z.number().int().nonnegative().nullable(), end: z.number().int().nonnegative().nullable(),
}).strict();
export type CodeBinding = z.infer<typeof CodeBindingInput>;
export type SavedBinding = z.infer<typeof SavedCodeBinding>;
