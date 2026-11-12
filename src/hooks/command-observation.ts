import { DiagnosticWriter } from "../observability/writer.js";
import { RuntimeSettings } from "../runtime/config.js";
import { bestEffort } from "../runtime/best-effort.js";
import type { NativeHookInput } from "./contracts.js";
import type { CommandDecision } from "./shell-policy.js";
import type { DiagnosticContext } from "../observability/diagnostic-context.js";
import { hookDiagnosticContext } from "./diagnostic-context.js";
import { toolWorkingDirectory } from "./tool-policy.js";

/** 只记录固定分类原因；不采集命令、参数或路径。诊断失败不能使正常读取被拒绝。 */
export async function observeCommandDecision(input: NativeHookInput, decision: CommandDecision | undefined, home?: string,
  correlation: { call?: string; operation?: string; workdir?: string; context?: DiagnosticContext; enabled?: boolean } = {}) {
  if (!decision || input.hook_event_name !== "PreToolUse") return;
  const context = { ...(correlation.context ?? hookDiagnosticContext(input, decision)), stage: "classify" as const };
  // 保留高频普通读取的原采样边界，但nl是已出现误判的能力族，须能看见修复后的放行。
  if (decision.reason === "COMMAND_READ_ONLY_SINGLE" && context.command_family !== "number_lines") return;
  if (["read_only", "management"].includes(decision.classification)) { context.decision = "allow"; context.required_action = "none"; }
  await bestEffort(async () => {
    if (correlation.enabled !== true && (await new RuntimeSettings(home).current()).mode !== "auto") return;
    await new DiagnosticWriter(home).record("decision.recorded", { session: input.session_id, trace: input.turn_id ?? input.session_id,
      ...(correlation.call ? { call: correlation.call } : {}), ...(correlation.operation ? { operation: correlation.operation } : {}),
      workdir: correlation.workdir ?? toolWorkingDirectory(input), context,
      reason: `${decision.reason}_${decision.dialect.toUpperCase()}`, attributes: { event: "PreToolUse", transport: "hook",
        coverage: decision.classification === "unknown" ? "partial" : "observed" } });
  }, 50);
}
