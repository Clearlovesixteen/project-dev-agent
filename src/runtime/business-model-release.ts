import { AppError } from "../domain/error.js";

declare const PROJECT_DEV_AGENT_MODEL_WRITES: boolean;

/** 兼容包能读 v3 模型和任务。发布构建可以先关闭增强写入，给旧安装留出升级窗口。 */
export const enhancedModelWrites = typeof PROJECT_DEV_AGENT_MODEL_WRITES === "undefined" || PROJECT_DEV_AGENT_MODEL_WRITES;

export function assertEnhancedModelWrites(required: boolean): void {
  if (required && !enhancedModelWrites) throw new AppError("BUSINESS_MODEL_READ_ONLY", "当前是业务模型兼容版，可查看增强记录。继续增强开发请使用支持写入的新版插件");
}
