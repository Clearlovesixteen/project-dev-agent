#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { handleHook } from "./handler.js";
import { DiagnosticWriter } from "../observability/writer.js";
import { bestEffort } from "../runtime/best-effort.js";
import type { TelemetryAttributes } from "../observability/contracts.js";
import { HookInput, denyWrite, type NativeHookInput } from "./contracts.js";
import { writeKind } from "./tool-policy.js";

/** 独立于 MCP 协议；stdout 只输出一个合法 JSON，预算到期只停止项目辅助。 */
let finished = false, expired = false;
const invocation = randomUUID(), controller = new AbortController();
let correlation: { session?: string; trace?: string } = { trace: invocation };
let pendingInput: NativeHookInput | undefined;
let activeMode: "manual" | "observe" | "auto" | undefined;
const pluginRoot = process.env.PROJECT_DEV_PLUGIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 内部预算到期时返回合法拒绝，不用空 JSON 把未完成的修改检查误当成功。 */
function unavailable(reason: string) {
  if (activeMode === "manual" || activeMode === "observe") return {};
  // 项目发现或摘要读取过慢时保留轻量入口；它不声称范围已核对或资料已准备。
  // 只有已读到 auto 才能注入，不能越过损坏配置或用户的关闭选择。
  if (activeMode === "auto" && pendingInput && ["SessionStart", "UserPromptSubmit"].includes(pendingInput.hook_event_name))
    return { systemMessage: `Project Dev Agent：项目摘要暂未就绪（${reason}），已保留开发入口。`,
      hookSpecificOutput: { hookEventName: pendingInput.hook_event_name,
        additionalContext: `Project Dev Agent 自动参与入口。项目摘要尚未就绪；本轮如属用户已授权的项目开发，先读取 ${resolve(pluginRoot, "skills/project-dev/SKILL.md")}，以真实 Git 根目录调用 project_prepare(apply:true)，再查询 project_context、建立或恢复任务后修改。按工具核对原有工作范围，不自动扩大；其他专业 Skill 继续主导；普通讨论和阅读不建任务。不能把本条入口当成项目依据或本轮开发已完成。` } };
  return pendingInput?.hook_event_name === "PreToolUse" && writeKind(pendingInput)
    ? denyWrite(`Project Dev Agent：修改前检查未完成（${reason}）。先核对项目准备及运行状态，再重试。`)
    : pendingInput ? { systemMessage: `Project Dev Agent：本轮辅助未完成（${reason}），不能记为插件已参与。` } : {};
}
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
  hardTimer = setTimeout(() => { expired = true; controller.abort(); finish(unavailable("HOOK_DEADLINE")); }, hard);
  softTimer = setTimeout(async () => {
    expired = true; controller.abort();
    await bestEffort(() => new DiagnosticWriter().record("telemetry.gap", { ...correlation, outcome: "degraded", reason: "HOOK_DEADLINE" }), 150);
    finish(unavailable("HOOK_DEADLINE"));
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
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const parsed = HookInput.safeParse(input);
  if (parsed.success) pendingInput = parsed.data;
  // 仅完整读入的异步 Stop 允许更长网络预算；输入未结束和同步项目辅助仍走原短期限。
  if (input && typeof input === "object" && "hook_event_name" in input && input.hook_event_name === "Stop") budget(5500, 6000);
  if (input && typeof input === "object" && "session_id" in input && typeof input.session_id === "string" && input.session_id.length <= 200) {
    const turn = "turn_id" in input && typeof input.turn_id === "string" && input.turn_id.length <= 200 ? input.turn_id : undefined;
    correlation = { session: input.session_id, trace: turn ?? invocation };
  }
  const output = await handleHook(input, pluginRoot, undefined, { trace: invocation, signal: controller.signal, onMode: mode => { activeMode = mode; } });
  if (!expired) finish(output);
} catch { if (!expired) finish(unavailable("HOOK_RUNTIME_FAILED")); }
finally { clearTimeout(softTimer!); if (!expired) clearTimeout(hardTimer!); }
