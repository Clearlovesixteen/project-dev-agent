export class AppError extends Error {
  // 只有调用方可见的结构化修复信息可放在 data 中，不保存命令、代码原文或堆栈。
  constructor(public readonly code: string, message: string, public readonly data?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
  }
}
