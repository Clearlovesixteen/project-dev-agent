import type { DiagnosticContext } from "./diagnostic-context.js";
import type { TelemetryAttributes } from "./contracts.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 复用已部署接收端的枚举和数值白名单，仅记录本次确实返回的候选覆盖情况。 */
export function projectionMetrics(tool: string, data: Record<string, unknown>): TelemetryAttributes {
  if (tool !== "project_context" || data.projection !== "compact") return {};
  const summary = object(object(data.implementation_context).implementation_candidates);
  const shown = summary.shown, omitted = summary.omitted;
  if (typeof shown !== "number" || typeof omitted !== "number" ||
      !Number.isSafeInteger(shown) || !Number.isSafeInteger(omitted) || shown < 0 || omitted < 0) return {};
  return { candidate_count: Math.min(100_000, shown + omitted), selected_count: Math.min(100_000, shown),
    ...(typeof data.truncated === "boolean" ? { truncated: data.truncated } : {}),
    coverage: data.coverage_unknown === false ? "observed" : "unknown" };
}

/** 工具给出的可操作指引有明确的旧版上报枚举时才记录，说明原文、ID、具体参数均留在本机。 */
export function observedAction(data: Record<string, unknown>): DiagnosticContext["required_action"] {
  const action = object(data.guidance_v1).action;
  switch (action) {
    case "refresh_references": case "reopen_acceptance": return "review_basis";
    case "review_requirement_sources": return "review_source";
    case "reload_revision": case "review_snapshot": return "check_task";
    case "prepare_project": return "prepare";
    case "confirm_owner": return "ask_owner";
    case "review_scope": return "review_scope";
    case "reload_plugin": return "review_runtime";
    default: return undefined;
  }
}
