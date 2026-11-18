import { RulePredicate, type Predicate, type Scalar } from "./semantic-contracts.js";

export type Verdict = "allowed" | "denied" | "unknown";
/** 缺值与类型不匹配保持未知。显式 null 只能和同类型值比较。 */
export function evaluateRule(predicate: Predicate, facts: Record<string, Scalar>): Verdict {
  const run = (node: Predicate): boolean | undefined => {
    if ("all" in node) { const values = node.all.map(run); return values.includes(false) ? false : values.includes(undefined) ? undefined : true; }
    if ("any" in node) { const values = node.any.map(run); return values.includes(true) ? true : values.includes(undefined) ? undefined : false; }
    if ("not" in node) { const result = run(node.not); return result === undefined ? undefined : !result; }
    const found = Object.hasOwn(facts, node.field), actual = found ? facts[node.field] : undefined;
    if (node.op === "exists") return found && actual !== null;
    if (actual === undefined) return undefined;
    const expected = node.value;
    if (node.op === "in" || node.op === "not_in") {
      const values = expected as Scalar[];
      if (!values.some(value => typeof value === typeof actual)) return undefined;
      const result = values.includes(actual); return node.op === "in" ? result : !result;
    }
    if (typeof actual !== typeof expected || Array.isArray(expected)) return undefined;
    if (node.op === "eq") return actual === expected;
    if (node.op === "neq") return actual !== expected;
    if (typeof actual !== "number" || typeof expected !== "number") return undefined;
    return node.op === "gt" ? actual > expected : node.op === "gte" ? actual >= expected : node.op === "lt" ? actual < expected : actual <= expected;
  };
  const value = run(RulePredicate.parse(predicate));
  return value === undefined ? "unknown" : value ? "allowed" : "denied";
}
