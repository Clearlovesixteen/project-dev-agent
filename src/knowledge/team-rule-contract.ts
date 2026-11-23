import { z } from "zod";
import { IdSchema, TextSchema } from "../domain/common.js";
import { KnowledgeSchema, type Knowledge } from "../domain/knowledge.js";
import { digest } from "../domain/digest.js";
import { redact } from "../history/codex-reader.js";
import { ConcretePath, HASH } from "../understanding/fields.js";
import { AppError } from "../domain/error.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { excluded } from "../understanding/scan.js";
import type { ProjectConfig } from "./config.js";

// 启用标记随 Git 共享，独立 clone 使用相同标识。旧版读取器会忽略 JSON 文件。
export const TEAM_RULE_POLICY = ".project-dev/team-rules.json";
export const TeamRulePolicy = z.object({ schema_version: z.literal(1), project_key: z.uuid() }).strict();
export async function teamRulePolicy(files: ProjectFiles) {
  try { return TeamRulePolicy.parse(JSON.parse(await files.read(TEAM_RULE_POLICY, 1024))); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}

/** 共享字段白名单之外，再拒绝可识别的凭据与本机路径；自由文本仍要由维护者检查。 */
const portableText = z.string().trim().min(1).max(1000).refine(text =>
  !redact(text).count && !/(?:^|[\s(（="'：])(?:\/(?:[^\s/]+\/)+|~\/|[a-z]:[\\/]|\\\\)|file:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(text),
  "请移除共享文本中的私人路径、邮箱或凭据，再重新审核");
const path = ConcretePath.and(portableText).refine(value => !/[#:\r\n]/.test(value), "来源路径不能与行号或符号标记混淆");
/** 合并例外后仍须满足原知识工具的正文长度上限，在草稿阶段报告超限。 */
function ruleText(rule: { description: string; exceptions: string[] }) {
  return [rule.description, ...rule.exceptions.map(item => "例外：" + item)].join("\n");
}
export const TeamRule = z.object({
  schema_version: z.literal(1), project_key: z.uuid(), model_id: IdSchema.and(portableText), rule_id: IdSchema.and(portableText),
  model_revision: z.number().int().positive(), rule_fingerprint: HASH, module: portableText, description: portableText,
  conditions: z.array(portableText).min(1).max(8), exceptions: z.array(portableText).max(8),
  sources: z.array(z.object({ kind: z.enum(["code", "document"]), path, sha256: HASH,
    line: z.number().int().positive().optional(), symbol: portableText.refine(s => !/[#\r\n]/.test(s)).optional() }).strict()).min(1).max(30),
}).strict().refine(rule => TextSchema.safeParse(ruleText(rule)).success, "规则正文与例外超出共享知识长度上限");
export type TeamRule = z.infer<typeof TeamRule>;
export const TeamRuleDraft = z.object({ rule: TeamRule, previous_version: HASH.nullable() }).strict();
export const ReviewedTeamRule = z.object({ rule: TeamRule, reviewer: portableText, reviewed_at: z.string().datetime() }).strict();

/** ID 仅由项目、模型和规则身份组成。新修订仍落在同一份 Git 文件，便于 PR 比对。 */
export function teamRuleId(rule: TeamRule): string {
  return "team-" + digest(JSON.stringify([rule.project_key, rule.model_id, rule.rule_id])).slice(0, 32);
}

/** 在目标工作树投影为原有知识合同，之后的查询与任务登记继续使用原有来源核验。 */
export function teamKnowledge(config: ProjectConfig, reviewed: z.infer<typeof ReviewedTeamRule>, projectKey: string): Knowledge {
  const { rule } = reviewed;
  if (rule.project_key !== projectKey) throw new AppError("TEAM_RULE_PROJECT_MISMATCH", "规则与当前仓库启用标记不一致");
  if (rule.sources.some(source => excluded(source.path, config)))
    throw new AppError("TEAM_RULE_SOURCE_EXCLUDED", "规则包含当前项目排除的来源");
  return KnowledgeSchema.parse({ schema_version: 1, id: teamRuleId(rule), title: rule.rule_id, type: "business_rule", status: "confirmed",
    modules: [rule.module], paths: [...new Set(rule.sources.map(source => source.path))],
    applicable_conditions: rule.conditions, rule: ruleText(rule),
    rationale: `团队审核的模型 ${rule.model_id} / ${rule.rule_id}，来源修订 ${rule.model_revision}`,
    sources: rule.sources.map(source => ({ kind: source.kind, sha256: source.sha256,
      reference: source.path + (source.symbol ? "#" + source.symbol : source.line ? ":" + source.line : "") })),
    confirmed_by: reviewed.reviewer, reviewed_at: reviewed.reviewed_at,
  });
}
