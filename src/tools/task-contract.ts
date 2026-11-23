import { createHash, createHmac, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ToolResult } from "../domain/result.js";
import { domainGuidance } from "./task-guidance.js";
import { guidanceEnabled } from "../runtime/guidance-release.js";
import { Interaction } from "../workflow/interaction.js";
import { VERSION } from "../version.js";
import { IdSchema } from "../domain/common.js";

/** 客户端发现的仍是完整参数契约。MCP 先接收原始对象，随后在业务处理前严格校验并记录成组诊断。 */
export function taskTransportSchema(contract: z.ZodObject) {
  return z.looseObject({}).meta(z.toJSONSchema(contract, { io: "input", target: "draft-7" }));
}

/** 仅返回契约中的字段名和已知旧键，不把任意未知键、原文或路径带回错误响应。 */
function wireReferenceIssues(error: z.ZodError, input: unknown) {
  const byIndex = new Map<number, Set<string>>();
  const reportable = new Set(["id", "path", "line", "sha256", "quote", "reason"]);
  for (const issue of error.issues) {
    const [basis, references, index, field] = issue.path;
    if (basis !== "implementation_basis" || references !== "references" || typeof index !== "number" || index >= 12) continue;
    const fields = byIndex.get(index) ?? new Set<string>();
    byIndex.set(index, fields);
    if (typeof field === "string" && reportable.has(field)) fields.add(field);
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) fields.add(reportable.has(key) ? key : "unknown_field");
  }
  // 结构错时也能使用符合格式的引用 ID 来定位；字段缺失时保留原下标即可。
  const refs = (input as { implementation_basis?: { references?: unknown } } | undefined)?.implementation_basis?.references;
  return [...byIndex].map(([index, fields]) => {
    const id = IdSchema.safeParse(Array.isArray(refs) ? refs[index]?.id : undefined);
    return { index, ...(id.success ? { id: id.data } : {}), fields: [...fields].sort(), reason: "invalid_fields" };
  });
}

/** 沿用旧版完整视图。只有主动使用紧凑返回的客户端接收结构化指引。 */
function compactGuidance(input: unknown) {
  return guidanceEnabled() && !!input && typeof input === "object" && "response_view" in input && input.response_view === "compact";
}

/** 只在当前 MCP 进程记住错误摘要和到期时间，不缓存任何业务结果或原始参数。 */
export class TaskInputFailures {
  private readonly failures = new Map<string, number>();
  private readonly contractKey = randomBytes(32);

  /** 只省略已交付的静态说明；重启、压缩后未带标识或会话/工作树不匹配时重新给出全文。 */
  private contractReference(name: string, input: unknown, hint: string) {
    if (!input || typeof input !== "object") return;
    const raw = input as Record<string, unknown>;
    if (raw.response_view !== "compact" || typeof raw.project !== "string" || !isAbsolute(raw.project)) return;
    const identity = Interaction.safeParse(raw.interaction);
    if (!identity.success) return;
    const id = createHmac("sha256", this.contractKey)
      .update(JSON.stringify([VERSION, name, raw.project, identity.data.session_id, identity.data.actor_id ?? "main", hint]))
      .digest("hex");
    return { contract_id: id, contract_state: raw.guidance_contract_id === id ? "reference" : "full" };
  }

  private repeated(name: string, input: unknown, code: string) {
    // 回执标识仅影响展示，上次无效业务参数即使附上它，仍属于原样重试。
    const { guidance_contract_id: _contract, ...payload } = (input ?? {}) as Record<string, unknown>;
    const canonical = JSON.stringify(payload, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
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

  /** 每次重新执行领域校验，首个失败就给出具体动作。重复标记不能代替实际状态检查。 */
  adviseAfterExecution(name: string, input: unknown, result: ToolResult) {
    if (result.outcome !== "error") return result;
    const fields: Record<string, unknown> = typeof result.data === "object" && result.data !== null && !Array.isArray(result.data)
      ? { ...result.data } : result.data === undefined ? {} : { details: result.data };
    const guide = domainGuidance(name, result.code, result.diagnostics[0]?.message ?? "核对当前操作的实际前置条件。", fields);
    const { reference_issues: _issues, verified_reference_ids: _verified, acceptance_ids: _acceptance, task_revision: _revision, ...prior } = fields;
    const duplicate = this.repeated(name, input, result.code);
    if (!compactGuidance(input)) {
      // 完整/回退视图维持既有数据和错误文本。只有重复失败时增加旧版约定的动作提示。
      if (!duplicate) return result;
      return { ...result, data: { ...fields, retry_same_input: false, required_action: guide.instruction } };
    }
    const { instruction, ...structured } = guide;
    return { ...result, data: { ...prior, retry_same_input: false, required_action: instruction,
      guidance_v1: { ...structured, ...(duplicate ? { repeated_failure: true } : {}) } } };
  }

  diagnose(name: string, input: unknown, error: z.ZodError): ToolResult {
    const duplicate = this.repeated(name, input, "WIRE_INPUT_INVALID");
    const fields = [...new Set(error.issues.map(issue => issue.path.map(part => typeof part === "number" ? "[]" : String(part)).join(".") || "arguments"))].slice(0, 12);
    const code = duplicate ? "TASK_INPUT_RETRY_STOPPED" : "TASK_INPUT_INVALID";
    const hint = fields.some(field => field.startsWith("implementation_basis"))
      ? "每条引用提交 id、仓库相对 path 和已读原文 quote，必要时补行号；每项决策提交 id、constraint、implementation、reference_ids 和已有 acceptance_id。旧版 reason/decision 无法推导真实引用或验收。"
      : "读取当前工具契约，核对所列字段和允许的值。";
    const compact = compactGuidance(input);
    const issues = compact ? wireReferenceIssues(error, input) : [];
    const contract = compact ? this.contractReference(name, input, hint) : undefined;
    const instruction = contract?.contract_state === "reference" ? "按本会话已取得的契约修正所列字段。" : hint;
    return { outcome: "error", code, data: { fields, retry_same_input: false, ...(compact ? { guidance_v1: { action: "repair_input", tool: name, ...contract,
      fields, retry_same_input: false, ...(issues.length ? { reference_issues: issues } : {}) } } : {}) }, diagnostics: [{ code,
      message: (duplicate ? "重复的无效请求已停止。 " : "") + instruction + " 仅在修正参数后重新提交。" }] };
  }
}
