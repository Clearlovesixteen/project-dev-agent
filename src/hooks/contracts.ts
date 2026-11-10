import { z } from "zod";

/** 宿主可添加字段；这里只读取版本稳定的身份、事件和工具输入。 */
export const HookInput = z.object({
  hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
  cwd: z.string().max(4096), session_id: z.string().min(1).max(200), turn_id: z.string().max(200).optional(),
  agent_id: z.string().max(200).optional(), prompt: z.string().max(200_000).optional(),
  source: z.enum(["startup", "resume", "clear", "compact", "fork"]).optional(),
  tool_name: z.string().max(300).optional(), tool_use_id: z.string().max(300).optional(),
  tool_input: z.unknown().optional(), tool_response: z.unknown().optional(),
});
export type NativeHookInput = z.infer<typeof HookInput>;

export function denyWrite(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
