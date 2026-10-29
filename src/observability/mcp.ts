import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventAttributes } from "./contracts.js";
import { DiagnosticWriter, observeTool } from "./writer.js";
import { currentInteraction, Interaction, interactionStorage, type InteractionContext } from "../workflow/interaction.js";
import { ContextReceipts } from "../context/receipts.js";
import { bestEffort } from "../runtime/best-effort.js";

type Registration = (name: string, config: Record<string, unknown>, handler: (...input: unknown[]) => unknown) => unknown;

/**
 * 通过 SDK 的公开注册接口包装 handler，保留原有参数校验、权限注解和返回结构。
 * SDK 在 handler 之前拒绝的无效参数不进入此统计，报告必须保留这一覆盖限制。
 */
export function instrumentMcp(server: McpServer, home?: string) {
  // 类型擦除只位于协议适配边界；外部调用继续使用 SDK 原有泛型签名。
  const register = server.registerTool.bind(server) as unknown as Registration, writer = new DiagnosticWriter(home);
  const registration: Registration = (name, config, handler) => {
    const wrapped = (async (...received: unknown[]) => {
      const raw = received[0];
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
          raw && typeof raw === "object" && "project" in raw && typeof raw.project === "string" ? raw.project : undefined, invoke) : await invoke();
        // 诊断适配失败不能改变已经完成的业务调用；回执匹配也不等于模型真的采用了内容。
        await bestEffort(async () => {
        try {
          const project = raw && typeof raw === "object" && "project" in raw && typeof raw.project === "string" ? raw.project : undefined;
          const envelope = result as { structuredContent?: { outcome?: string; data?: Record<string, unknown> } };
          const value = envelope.structuredContent;
          if (project && interaction && name === "project_context" && typeof value?.data?.context_id === "string") {
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
        return result;
      });
    });
    return register(name, config, wrapped);
  };
  server.registerTool = registration as unknown as McpServer["registerTool"];
}
