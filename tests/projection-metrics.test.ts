import assert from "node:assert/strict";
import test from "node:test";
import { EventAttributes } from "../src/observability/contracts.js";
import { observedAction, projectionMetrics } from "../src/observability/projection-metrics.js";

test("投影诊断复用现有接收白名单，缺测和零命中分别计数", () => {
  const data = { projection: "compact", implementation_context: { implementation_candidates:
    { shown: 0, omitted: 2, query: "病历原文", paths: ["src/private.ts"] } }, coverage_unknown: true, truncated: true };
  const metrics = projectionMetrics("project_context", data);
  assert.deepEqual(EventAttributes.parse(metrics), { selected_count: 0, candidate_count: 2, coverage: "unknown", truncated: true });
  assert.deepEqual(projectionMetrics("project_context", {}), {});
  assert.deepEqual(projectionMetrics("task_check", data), {});
  assert.equal(observedAction({ guidance_v1: { action: "refresh_references", reference_issues: ["src/private.ts"] } }), "review_basis");
  assert.equal(observedAction({ guidance_v1: { action: "unverified-text" } }), undefined);
});
