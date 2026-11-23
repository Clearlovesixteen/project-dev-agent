import { AppError } from "../domain/error.js";
import { feedbackContext } from "../feedback/service.js";
import { searchHistoryHints } from "../history/search.js";
import type { ProjectFiles } from "../storage/project-files.js";

/** 日常查询和详情共用同一套条件、版本及证据判定。两类来源独立降级。 */
export async function searchSupportContext(files: ProjectFiles, query: string, paths: string[], limit: number, compact = false) {
  const [feedback, history] = await Promise.allSettled([
    feedbackContext(files, query, paths, compact ? 12 : undefined),
    searchHistoryHints(files, query, paths, limit, compact ? 4 : undefined),
  ]);
  const diagnostics = [];
  if (feedback.status === "rejected") diagnostics.push({ code: "FEEDBACK_CONTEXT_UNAVAILABLE", message: "即时纠正读取未完成" });
  if (history.status === "rejected") diagnostics.push({ code: "HISTORY_HINTS_UNAVAILABLE", message: "历史候选读取未完成" });
  return {
    feedback: feedback.status === "fulfilled" ? { state: "available", ...feedback.value }
      : { state: feedback.reason instanceof AppError && feedback.reason.code === "FEEDBACK_LOOKUP_REQUIRED" ? "lookup_required" : "unavailable",
          version: null, items: [], truncated: true },
    history: history.status === "fulfilled" ? history.value : { state: "unavailable", hints: [], truncated: true },
    diagnostics,
  };
}
