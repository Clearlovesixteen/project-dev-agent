import { DiagnosticWriter } from "../observability/writer.js";
import { RuntimeSettings } from "../runtime/config.js";
import { bestEffort } from "../runtime/best-effort.js";
import type { NativeHookInput } from "./contracts.js";
import type { CommandDecision } from "./shell-policy.js";

/** 只记录固定分类原因；不采集命令、参数或路径。诊断失败不能使正常读取被拒绝。 */
export async function observeCommandDecision(input: NativeHookInput, decision: CommandDecision | undefined, home?: string) {
  if (!decision || input.hook_event_name !== "PreToolUse" || decision.reason === "COMMAND_READ_ONLY_SINGLE") return;
  await bestEffort(async () => {
    if ((await new RuntimeSettings(home).current()).mode !== "auto") return;
    await new DiagnosticWriter(home).record("decision.recorded", { session: input.session_id, trace: input.turn_id ?? input.session_id,
      reason: `${decision.reason}_${decision.dialect.toUpperCase()}`, attributes: { event: "PreToolUse", transport: "hook",
        coverage: decision.classification === "unknown" ? "partial" : "observed" } });
  }, 50);
}
