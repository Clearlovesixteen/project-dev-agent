import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { AppError } from "../domain/error.js";

/** 关联当前请求而不使用进程级“当前项目”；旧调用可省略，不能据缺失身份自动认领其他会话。 */
export const Interaction = z.object({
  session_id: z.string().min(1).max(200), turn_id: z.string().min(1).max(200).optional(),
  actor_id: z.string().min(1).max(200).optional(), operation_id: z.uuid().optional(),
  context_id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type InteractionContext = z.infer<typeof Interaction>;
export const interactionStorage = new AsyncLocalStorage<InteractionContext | undefined>();
export function currentInteraction() { return interactionStorage.getStore(); }
export function interactionOwner(value: InteractionContext) {
  return { session_id: value.session_id, actor_id: value.actor_id ?? "main" };
}

/** 身份只保护新任务不被其他聊天误接管；旧任务继续沿用原来的显式操作方式。 */
export function assertTaskOwner(task: { owner?: { session_id: string; actor_id: string } | undefined }) {
  if (!task.owner) return;
  const current = currentInteraction();
  if (!current) throw new AppError("TASK_SESSION_REQUIRED", "此任务已绑定会话，继续操作须携带原会话身份");
  const owner = interactionOwner(current);
  if (owner.session_id !== task.owner.session_id || owner.actor_id !== task.owner.actor_id)
    throw new AppError("TASK_SESSION_MISMATCH", "当前活跃任务属于另一会话，请勿自动接管");
}
