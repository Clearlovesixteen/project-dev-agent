import assert from "node:assert/strict";
import test from "node:test";
import { RulePredicate, type Predicate } from "../src/understanding/semantic-contracts.js";
import { evaluateRule } from "../src/understanding/rule-predicates.js";
import { codeSymbols, outsideBindings, selectSymbol } from "../src/understanding/symbol-index.js";

const when: Predicate = { all: [{ field: "application.status", op: "eq", value: "COMPLETED" },
  { field: "sync.status", op: "in", value: ["NOT_SYNCED", "FAIL"] }, { not: { field: "request.busy", op: "eq", value: true } }] };

test("业务条件区分允许、拒绝和缺少事实，不转换值类型或执行表达式", () => {
  assert.equal(evaluateRule(when, { "application.status": "COMPLETED", "sync.status": "FAIL", "request.busy": false }), "allowed");
  assert.equal(evaluateRule(when, { "application.status": "DRAFT" }), "denied");
  assert.equal(evaluateRule(when, { "application.status": "COMPLETED", "sync.status": "FAIL" }), "unknown");
  assert.equal(evaluateRule({ field: "qty", op: "gte", value: 10 }, { qty: "10" }), "unknown");
  assert.equal(evaluateRule({ any: [{ field: "a", op: "eq", value: true }, { field: "b", op: "eq", value: true }] }, { b: true }), "allowed");
  assert.equal(evaluateRule({ not: { field: "qty", op: "gt", value: 0 } }, {}), "unknown");
  assert.equal(evaluateRule({ field: "nested.flag", op: "eq", value: true }, Object.create({ "nested.flag": true })), "unknown");
  assert.equal(evaluateRule({ field: "sync", op: "eq", value: null }, { sync: null }), "allowed");
});

test("规则条件拒绝递归过深、原型访问、非法操作及错误值类型", () => {
  let deep: Predicate = { field: "a", op: "exists" };
  for (let i = 0; i < 8; i++) deep = { not: deep };
  const cyclic: any = {}; cyclic.not = cyclic;
  for (const bad of [deep, cyclic, { all: [] }, { field: "__proto__.x", op: "eq", value: 1 },
    { field: "constructor.x", op: "exists" }, { field: "x", op: "call", value: "process.exit()" },
    { field: "x", op: "in", value: 1 }, { field: "x", op: "gt", value: "1" }, { field: "x", op: "exists", value: false }])
    assert.equal(RulePredicate.safeParse(bad).success, false);
});

test("静态代码绑定按作用域定位真实符号，保留重名和不支持状态", () => {
  const code = "export function canSync(){ return true; }\nexport const other = { canSync(){ return false; } };\n";
  assert.deepEqual(codeSymbols("src/a.ts", code).symbols.map(item => item.name), ["canSync", "other", "other.canSync"]);
  assert.equal(selectSymbol("a.ts", code, "canSync").resolution, "resolved");
  assert.equal(selectSymbol("a.ts", "{ let item = 1; } { let item = 2; }", "item").resolution, "ambiguous");
  assert.equal(selectSymbol("a.vue", "<template/>", "canSync").resolution, "unsupported");
  assert.equal(selectSymbol("a.ts", "export const = ;", "canSync").resolution, "unsupported");
  assert.equal(selectSymbol("a.ts", code, "missing").resolution, "missing");
  assert.equal(selectSymbol("a.tsx", "export const View = () => <div />;", "View").resolution, "resolved");
});

test("同文件检查只屏蔽获准符号，保留其他函数、导入和字符串内容差异", () => {
  const before = "import { request } from './request.js';\nexport const canSync = () => false;\nexport const view = () => 'a b';\n";
  const allowed = before.replace("() => false", "() => true");
  assert.equal(outsideBindings("a.ts", before, ["canSync"]), outsideBindings("a.ts", allowed, ["canSync"]));
  assert.notEqual(outsideBindings("a.ts", before, ["canSync"]), outsideBindings("a.ts", allowed.replace("'a b'", "'ab'"), ["canSync"]));
  assert.notEqual(outsideBindings("a.ts", before, ["canSync"]), outsideBindings("a.ts", allowed.replace("./request.js", "axios"), ["canSync"]));
  assert.equal(outsideBindings("a.ts", before, []), outsideBindings("a.ts", before.replaceAll("\n", "\n\n"), []));
  assert.equal(outsideBindings("a.ts", "", ["canSync"]), outsideBindings("a.ts", "export const canSync = () => false;", ["canSync"]));
  assert.notEqual(outsideBindings("a.ts", "function protectedFn(){ return true }", []), outsideBindings("a.ts", "function protectedFn(){ return\ntrue }", []));
});
