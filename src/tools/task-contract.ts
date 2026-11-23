import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolResult } from "../domain/result.js";

/** 客户端发现的仍是完整参数契约。MCP 先接收原始对象，随后在业务处理前严格校验并记录成组诊断。 */
export function taskTransportSchema(contract: z.ZodObject) {
  return z.looseObject({}).meta(z.toJSONSchema(contract, { io: "input", target: "draft-7" }));
}

/** 重复错误的恢复动作。验证结果、源码与归属都可能变化，调用时必须重新执行原有检查。 */
const recoveryActions: Record<string, string> = {
  IMPLEMENTATION_REFERENCE_INVALID: "重新读取报错引用对应的文件和行，核实引用原文、行号和指纹。修正引用或恢复对应源码后再提交。",
  REQUIREMENT_SOURCE_INVALID: "读取当前任务需求原文或已授权的文档，修正来源类型、路径及原文后再提交。",
  VALIDATION_RUN_REQUIRED: "在当前工作树执行 validation run，确认对应检查的退出码与当前代码快照，再提交验收。",
  REVIEW_SNAPSHOT_REQUIRED: "运行完整 task_check 获取 review_snapshot，在这份快照上实际复核后带指纹提交。",
  REVIEW_ITEM_INVALID: "核对需复查的条目 ID、状态与证据，并在同份代码快照上提交完整集合。",
};

/** 只在当前 MCP 进程记住错误摘要和到期时间，不缓存任何业务结果或原始参数。 */
export class TaskInputFailures {
  private readonly failures = new Map<string, number>();

  private repeated(name: string, input: unknown, code: string) {
    const canonical = JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value);
    const hash = createHash("sha256").update(JSON.stringify([name, code])).update(canonical ?? "{}").digest("hex");
    const now = Date.now();
    const duplicate = (this.failures.get(hash) ?? 0) > now;
    this.failures.delete(hash);
    this.failures.set(hash, now + 120_000);
    if (this.failures.size > 128) this.failures.delete(this.failures.keys().next().value!);
    return duplicate;
  }

  /** 只在实际执行再次返回相同领域错误时补充恢复指引，保留原错误码与诊断。 */
  adviseAfterExecution(name: string, input: unknown, result: ToolResult) {
    if (result.outcome !== "error" || !this.repeated(name, input, result.code)) return result;
    const fields = typeof result.data === "object" && result.data !== null && !Array.isArray(result.data)
      ? result.data : result.data === undefined ? {} : { details: result.data };
    return { ...result, data: { ...fields, retry_same_input: false, required_action: recoveryActions[result.code]
      ?? (result.diagnostics[0]?.message || "核对当前工作树、任务修订和实际失败的前置条件") + "。处理本次失败的前置条件后再提交。" } };
  }

  diagnose(name: string, input: unknown, error: z.ZodError): ToolResult {
    const duplicate = this.repeated(name, input, "WIRE_INPUT_INVALID");
    const fields = [...new Set(error.issues.map(issue => issue.path.map(part => typeof part === "number" ? "[]" : String(part)).join(".") || "arguments"))].slice(0, 12);
    const code = duplicate ? "TASK_INPUT_RETRY_STOPPED" : "TASK_INPUT_INVALID";
    const hint = fields.some(field => field.startsWith("implementation_basis"))
      ? "每条引用提交 id、仓库相对 path 和已读原文 quote，必要时补行号；每项决策提交 id、constraint、implementation、reference_ids 和已有 acceptance_id。旧版 reason/decision 无法推导真实引用或验收。"
      : "读取当前工具契约，核对所列字段和允许的值。";
    return { outcome: "error", code, data: { fields, retry_same_input: false }, diagnostics: [{ code,
      message: (duplicate ? "重复的无效请求已停止。 " : "") + hint + " 仅在修正参数后重新提交。" }] };
  }
}
