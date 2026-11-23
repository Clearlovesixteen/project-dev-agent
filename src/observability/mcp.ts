import { inputDiagnosticContext } from "./tool-context.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventAttributes } from "./contracts.js";
import { DiagnosticWriter, observeTool } from "./writer.js";
import { currentInteraction, Interaction, interactionStorage, type InteractionContext } from "../workflow/interaction.js";
import { ContextReceipts } from "../context/receipts.js";
import { bestEffort } from "../runtime/best-effort.js";
import { ParticipationStore } from "../workflow/participation.js";
import { bindWorktree } from "../git/index.js";
import { implementationContextReady } from "../context/implementation-status.js";
import { z } from "zod";
import { TaskInputFailures, taskTransportSchema } from "../tools/task-contract.js";
import { compactTaskReceipt } from "../tools/task-receipt.js";
import type { ToolResult } from "../domain/result.js";

type Registration = (name: string, config: Record<string, unknown>, handler: (...input: unknown[]) => unknown) => unknown;

/**
 * 通过 SDK 的公开注册接口包装 handler，保留原有参数校验、权限注解和返回结构。
 * 任务写入工具使用相同契约自行校验，从而能在任务创建或修改前记录格式失败。
 */
export function instrumentMcp(server: McpServer, home?: string) {
  // 类型擦除只位于协议适配边界；外部调用继续使用 SDK 原有泛型签名。
  const register = server.registerTool.bind(server) as unknown as Registration, writer = new DiagnosticWriter(home);
  const failures = new TaskInputFailures();
  const registration: Registration = (name, config, handler) => {
    const taskContract = (name === "task_update" || name === "task_open") && config.inputSchema instanceof z.ZodObject
      ? config.inputSchema : undefined;
    const wrapped = (async (...received: unknown[]) => {
      const parsed = taskContract?.safeParse(received[0]);
      if (parsed && !parsed.success && (name === "task_open" || name === "task_update")) {
        const result = failures.diagnose(name, received[0], parsed.error);
        const raw = received[0] as Record<string, unknown>;
        const identity = Interaction.safeParse(raw.interaction);
        return interactionStorage.run(identity.success ? identity.data : undefined, () => observeTool(writer, name,
          typeof raw.project === "string" ? raw.project : undefined, async () => ({
            isError: true, structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }],
          })));
      }
      const raw = parsed?.success ? parsed.data : received[0];
      let interaction: InteractionContext | undefined;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const input = { ...raw } as Record<string, unknown>;
        interaction = input.interaction === undefined ? undefined : Interaction.parse(input.interaction);
        delete input.interaction;
        received[0] = input;
      }
      const tool = EventAttributes.shape.tool.unwrap().safeParse(name);
      const invoke = async () => handler(...received);
      return interactionStorage.run(interaction, async () => {
        const result = tool.success ? await observeTool(writer, tool.data,
          raw && typeof raw === "object" && "project" in raw && typeof raw.project === "string" ? raw.project : undefined, invoke, "mcp", {
            context: inputDiagnosticContext(name, raw),
            ...(raw && typeof raw === "object" && "task_id" in raw && typeof raw.task_id === "string" ? { task_id: raw.task_id } : {}),
          }) : await invoke();
        // 修改前检查的本地状态不属于遥测。关闭诊断仍维护它；更新失败须明确说明，
        // 但不能把已成功的业务写入改成 error，诱使调用方重复执行已完成的动作。
        if (raw && typeof raw === "object" && "project" in raw && typeof raw.project === "string" && interaction
          && ["project_context", "task_open", "task_update", "task_check"].includes(name)) {
          const envelope = result as { structuredContent?: { outcome?: string; data?: Record<string, unknown>; diagnostics?: { code: string; message: string }[] }; content?: { type: string; text?: string }[] };
          if (envelope.structuredContent && envelope.structuredContent.outcome !== "error") {
            try {
              const binding = await bindWorktree(raw.project);
              await new ParticipationStore(home).observedTool(binding.root, interaction, binding.branch, name, envelope.structuredContent);
            } catch {
              envelope.structuredContent.diagnostics?.push({ code: "PARTICIPATION_STATE_UNAVAILABLE", message: "业务调用结果已保留，但本轮参与状态未能保存；后续修改前须核对插件运行目录，不能重复执行已完成写入。" });
              const text = envelope.content?.find(item => item.type === "text");
              if (text) text.text = JSON.stringify(envelope.structuredContent);
            }
          }
        }
        // 诊断适配失败不能改变已经完成的业务调用；回执匹配也不等于模型真的采用了内容。
        await bestEffort(async () => {
        try {
          const project = raw && typeof raw === "object" && "project" in raw && typeof raw.project === "string" ? raw.project : undefined;
          const envelope = result as { structuredContent?: { outcome?: string; data?: Record<string, unknown> } };
          const value = envelope.structuredContent;
          if (project && interaction && name === "project_context" && value?.data
            && typeof value.data.context_id === "string" && implementationContextReady(value.data)) {
            await new ContextReceipts(home).issue(project, interaction, value.data.context_id);
          }
          if (project && currentInteraction()?.context_id) {
            const valid = await new ContextReceipts(home).valid(project, interaction!);
            await writer.record("context.acknowledged", { project, session: interaction!.session_id,
              ...(interaction?.turn_id ? { trace: interaction.turn_id } : {}), outcome: valid ? "ok" : "skipped",
              reason: valid ? "RECEIPT_MATCHED" : "RECEIPT_UNVERIFIED", evidence: "agent_reported",
              attributes: { context_id: interaction!.context_id! } });
          }
        } catch { /* 可观测性不改变业务操作结果。 */ }
        });
        // 完整任务先用于归属、回执和诊断，随后只精简客户端收到的任务记录。
        if (taskContract) {
          const full = result as { structuredContent: ToolResult };
          const compact = raw && typeof raw === "object" && "response_view" in raw && raw.response_view === "compact";
          const advised = failures.adviseAfterExecution(name, raw, full.structuredContent);
          const view = compact ? compactTaskReceipt(advised) : advised;
          if (view !== full.structuredContent) return { ...full, structuredContent: view, content: [{ type: "text", text: JSON.stringify(view) }] };
        }
        return result;
      });
    });
    return register(name, taskContract ? { ...config, inputSchema: taskTransportSchema(taskContract) } : config, wrapped);
  };
  server.registerTool = registration as unknown as McpServer["registerTool"];
}
