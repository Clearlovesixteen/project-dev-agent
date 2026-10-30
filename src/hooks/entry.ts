#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { handleHook } from "./handler.js";
import { DiagnosticWriter } from "../observability/writer.js";
import { bestEffort } from "../runtime/best-effort.js";
import type { TelemetryAttributes } from "../observability/contracts.js";

/** 独立于 MCP 协议；stdout 只输出一个合法 JSON，预算到期只停止项目辅助。 */
let finished = false, expired = false;
const invocation = randomUUID(), controller = new AbortController();
let correlation: { session?: string; trace?: string } = { trace: invocation };
function finish(result: Record<string, unknown>) {
  if (finished) return;
  finished = true;
  const serialized = JSON.stringify(result);
  process.stdout.write(serialized + "\n", async () => {
    // 只有实际写出 stdout 才记录 emitted；准备完成不能算成宿主已经接收到资料。
    const output = result.hookSpecificOutput as { additionalContext?: string; hookEventName?: TelemetryAttributes["event"] } | undefined;
    if (output?.additionalContext) {
      const contextId = /context_id=([a-f0-9]{64})/.exec(output.additionalContext)?.[1];
      await bestEffort(() => new DiagnosticWriter().record("context.emitted", { ...correlation,
        attributes: { transport: "hook", output_bytes: Buffer.byteLength(output.additionalContext!),
          ...(output.hookEventName ? { event: output.hookEventName } : {}), ...(contextId ? { context_id: contextId } : {}) } }), 50);
    }
    process.exit(0);
  });
}
let hardTimer: NodeJS.Timeout, softTimer: NodeJS.Timeout;
function budget(soft: number, hard: number) {
  clearTimeout(hardTimer); clearTimeout(softTimer);
  hardTimer = setTimeout(() => { expired = true; controller.abort(); finish({}); }, hard);
  softTimer = setTimeout(async () => {
    expired = true; controller.abort();
    await bestEffort(() => new DiagnosticWriter().record("telemetry.gap", { ...correlation, outcome: "degraded", reason: "HOOK_DEADLINE" }), 150);
    finish({});
  }, soft);
}
budget(1500, 1800);
try {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.from(chunk); bytes += part.length;
    if (bytes > 262_144) throw new Error("HOOK_INPUT_LIMIT");
    chunks.push(part);
  }
  const pluginRoot = process.env.PROJECT_DEV_PLUGIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // 仅完整读入的异步 Stop 允许更长网络预算；输入未结束和同步项目辅助仍走原短期限。
  if (input && typeof input === "object" && "hook_event_name" in input && input.hook_event_name === "Stop") budget(5500, 6000);
  if (input && typeof input === "object" && "session_id" in input && typeof input.session_id === "string" && input.session_id.length <= 200) {
    const turn = "turn_id" in input && typeof input.turn_id === "string" && input.turn_id.length <= 200 ? input.turn_id : undefined;
    correlation = { session: input.session_id, trace: turn ?? invocation };
  }
  const output = await handleHook(input, pluginRoot, undefined, { trace: invocation, signal: controller.signal });
  if (!expired) finish(output);
} catch { if (!expired) finish({}); }
finally { clearTimeout(softTimer!); if (!expired) clearTimeout(hardTimer!); }
