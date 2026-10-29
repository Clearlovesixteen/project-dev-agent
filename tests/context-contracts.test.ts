import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { businessGraph } from "../src/understanding/business-graph.js";
import type { SavedModel } from "../src/understanding/model-contracts.js";
import { boundedSummary } from "../src/context/summary.js";
import { DiagnosticEvent } from "../src/observability/contracts.js";
import { importedInsights, summarizeEvents } from "../src/observability/insights.js";

const model = (id: string, targets: string[] = []) => ({ id, schema_version: 2, revision: 1, title: id, entities: [],
  relations: targets.map((target, index) => ({ id: `edge-${index}`, target_model_id: target, rule_ids: ["rule"], source_ids: ["source"], kind: "depends_on", target_path: "src/source.ts" })) } as unknown as SavedModel);

test("关系图限制直接种子、节点、边和深度；循环和反向边不会无限扩散", () => {
  const large = Array.from({ length: 100 }, (_, index) => model(`m-${index}`, [`m-${(index + 1) % 100}`]));
  const graph = businessGraph(large, new Set(large.map(item => item.id)), 2);
  assert.ok(graph.nodes.length <= 20); assert.ok(graph.edges.length <= 30); assert.equal(graph.truncated, true);
  const chain = [model("a", ["b"]), model("b", ["c"]), model("c", ["d"]), model("d", ["b"])];
  assert.deepEqual(businessGraph(chain, new Set(["a"]), 1).nodes.map(item => item.id), ["a", "b"]);
  const expanded = businessGraph(chain, new Set(["a"]), 2);
  assert.deepEqual(new Set(expanded.nodes.map(item => item.id)), new Set(["a", "b", "c", "d"]));
  assert.equal(expanded.truncated, true);
  assert.equal(new Set(expanded.edges.map(edge => `${edge.from_model}:${edge.relation_id}`)).size, expanded.edges.length);
});

test("摘要按完整条目裁剪，保持 JSON 完整并把条件读取留给详情", () => {
  const summary = boundedSummary({ state: "indexed", files: [], models: [{ id: "orders", title: "订单", revision: 1,
    summary: "一".repeat(1000), rules: [{ id: "frozen", description: "二".repeat(1000), basis: "observed", conditions: ["完整条件不能从摘要推断"] }] }],
    implementation_context: { implementation_candidates: { candidates: [{ path: "src/shared.ts", quote: "三".repeat(5000) }] } } });
  assert.ok(Buffer.byteLength(summary) <= 4000);
  const parsed = JSON.parse(summary); assert.equal(parsed.truncated, true);
  assert.ok(!summary.includes("完整条件不能从摘要推断"));
  assert.deepEqual(parsed.implementation.candidates, []);
});

test("维护者导入同口径元数据，重复事件去重、异常不丢失，验证链路按任务关联", () => {
  const base = { schema_version: 1, occurred_at: new Date().toISOString(), install_id: randomUUID(), project_id: "a".repeat(64),
    session_id: null, task_id: "b".repeat(64), runtime_version: "0.12.0", policy_version: 1, mode: "auto", reason_code: "OK", duration_ms: 10,
    evidence_level: "observed", attributes: {} };
  const first = DiagnosticEvent.parse({ ...base, event_id: randomUUID(), trace_id: "c".repeat(64), event_name: "workflow.bound", outcome: "ok" });
  const second = DiagnosticEvent.parse({ ...base, event_id: randomUUID(), trace_id: "d".repeat(64), event_name: "validation.finished", outcome: "incomplete" });
  const report = importedInsights([{ success: true, results: [{ payload: JSON.stringify(first) }, { payload: JSON.stringify(second) }, { payload: JSON.stringify(first) }, { payload: "broken" }] }]);
  assert.equal(report.sample_events, 2); assert.equal(report.coverage.invalid, 1);
  assert.equal(report.traces[0]?.trace_id, second.trace_id);
  assert.deepEqual(report.traces[0]?.related_trace_ids, [first.trace_id]);
  assert.equal(summarizeEvents([], { invalid: 0, truncated: false }).hook_duration_ms.p95, null);
});
