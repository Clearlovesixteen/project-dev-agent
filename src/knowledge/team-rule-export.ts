import { randomUUID } from "node:crypto";
import { AppError } from "../domain/error.js";
import { IdSchema } from "../domain/common.js";
import { digest } from "../domain/digest.js";
import { assertStateIgnored, bindWorktree, type WorktreeBinding } from "../git/index.js";
import { modelVisible } from "../project-knowledge/model-visibility.js";
import { readProjectKnowledge } from "../project-knowledge/service.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { SavedModelSchema, SavedRuleV3 } from "../understanding/model-contracts.js";
import { ruleFingerprint, sourceFingerprint } from "../understanding/model-evidence.js";
import { safeSource } from "../understanding/scan.js";
import { loadConfig, type ProjectConfig } from "./config.js";
import { ReviewedTeamRule, TEAM_RULE_POLICY, TeamRule, TeamRuleDraft, teamRuleId, teamRulePolicy } from "./team-rule-contract.js";

const proposals = ".project-dev/local/proposals/";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function optionalFile(files: ProjectFiles, path: string) {
  try { return await files.read(path); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}

/** 只有维护者明确启用时才创建可随项目 Git 共享的标记，已有标记在重试时沿用。 */
export async function enableTeamRules(project: string) {
  const files = new ProjectFiles((await bindWorktree(project)).root);
  if (!await teamRulePolicy(files)) {
    try { await files.create(TEAM_RULE_POLICY, json({ schema_version: 1, project_key: randomUUID() })); }
    catch (error) { if (!hasCode(error, "FILE_EXISTS")) throw error; }
  }
  await teamRulePolicy(files);
  return { file: TEAM_RULE_POLICY, next_step: "请在团队 PR 中审查启用标记。删除标记可停用团队模型规则。" };
}

/** 从当前工作树唯一匹配的模型取一条有源码依据的现行规则；不复制对话、原文引用及本地模型元数据。 */
async function selectedRule(binding: WorktreeBinding, files: ProjectFiles, config: ProjectConfig, modelId: string, ruleId: string) {
  const policy = await teamRulePolicy(files);
  if (!policy) throw new AppError("TEAM_RULES_DISABLED", "请先明确启用此项目的团队模型规则");
  const view = await readProjectKnowledge(binding);
  const selected = view.selected_models?.find(model => model.model_id === modelId);
  if (!selected) throw new AppError("TEAM_RULE_MODEL_UNVERIFIED", "当前工作树缺少唯一匹配的模型，请先核对来源");
  const model = SavedModelSchema.parse({ ...(selected.content as object), project: binding.root });
  if (!modelVisible(model, config)) throw new AppError("TEAM_RULE_MODEL_UNVERIFIED", "模型超出当前工作树可见范围");
  const raw = model.schema_version !== 1 ? model.rules.find(candidate => candidate.id === ruleId) : undefined;
  if (!raw || model.schema_version === 1 || raw.basis !== "observed")
    throw new AppError("TEAM_RULE_NOT_OBSERVED", "请选择带稳定 ID 和实际来源的已观察规则");
  const rule = SavedRuleV3.parse(raw);
  const sources: TeamRule["sources"] = [];
  for (const id of rule.source_ids) {
    const source = model.sources.find(candidate => candidate.id === id);
    if (!source || source.kind === "task" || sourceFingerprint(source) !== rule.evidence_versions.find(item => item.id === id)?.fingerprint)
      throw new AppError("TEAM_RULE_NONPORTABLE", "规则含本地任务来源或未复核依据，请先以项目内文件重新核实");
    sources.push({ kind: source.kind, path: source.path, line: source.line, sha256: source.sha256 });
  }
  for (const anchor of rule.bindings ?? []) {
    if (anchor.resolution !== "resolved" || !anchor.target_sha256)
      throw new AppError("TEAM_RULE_SOURCE_STALE", "规则含未核实的代码绑定");
    sources.push({ kind: "code", path: anchor.path, sha256: anchor.target_sha256, ...(anchor.symbol ? { symbol: anchor.symbol } : {}) });
  }
  if (!sources.some(source => source.kind === "code")) throw new AppError("TEAM_RULE_CODE_REQUIRED", "共享业务规则需要可在新工作树核验的代码来源");
  const hashes = new Map<string, string>();
  for (const source of sources) {
    if (!hashes.has(source.path)) hashes.set(source.path, digest(await safeSource(files, source.path, config)));
    if (hashes.get(source.path) !== source.sha256) throw new AppError("TEAM_RULE_SOURCE_STALE", "共享规则的代码或文档已变化，请重新核实");
  }
  return TeamRule.parse({ schema_version: 1, project_key: policy.project_key, model_id: model.id, rule_id: rule.id,
    model_revision: model.revision, rule_fingerprint: ruleFingerprint({ ...rule, source_ids: [] }), module: model.module, description: rule.description,
    conditions: rule.conditions, exceptions: rule.exceptions, sources });
}

/** 先写 Git 忽略的本地草稿，携带原共享版本以识别导出后发生的并发审查。 */
export async function exportTeamRule(project: string, modelId: string, ruleId: string) {
  const binding = await bindWorktree(project);
  await assertStateIgnored(binding);
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const rule = await selectedRule(binding, files, config, IdSchema.parse(modelId), IdSchema.parse(ruleId));
  const id = teamRuleId(rule), target = `${config.knowledge_dir}/${id}.rule.json`;
  const current = await optionalFile(files, target);
  const content = json({ rule, previous_version: current === undefined ? null : digest(current) });
  const file = `${proposals}${id}-${digest(content).slice(0, 16)}.rule.json`;
  try { await files.create(file, content, 32_768); }
  catch (error) { if (!hasCode(error, "FILE_EXISTS") || await files.read(file) !== content) throw error; }
  return { file, target, id, status: "candidate", next_step: "请检查草稿的规则、适用条件、例外与相对来源，再使用 knowledge review 提交团队审查。" };
}

/** 本地明确审核后写入一条共享记录；不自动提交。重新核验模型和旧版本，避免无意覆盖。 */
export async function reviewTeamRule(binding: WorktreeBinding, file: string, reviewer: string) {
  if (!file.startsWith(proposals) || file.slice(proposals.length).includes("/") || !file.endsWith(".rule.json"))
    throw new AppError("REVIEW_PATH_INVALID", "团队规则审核只接受本地导出草稿");
  await assertStateIgnored(binding);
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const draft = TeamRuleDraft.parse(JSON.parse(await files.read(file)));
  const rule = await selectedRule(binding, files, config, draft.rule.model_id, draft.rule.rule_id);
  if (json(rule) !== json(draft.rule)) throw new AppError("TEAM_RULE_DRAFT_STALE", "草稿与当前模型不同。请重新导出、核对并审核");
  const id = teamRuleId(rule), target = `${config.knowledge_dir}/${id}.rule.json`;
  const release = await acquireFileLock(files, `.project-dev/local/team-rules/${id}.lock`, "TEAM_RULE_REVIEW_BUSY");
  try {
    const current = await optionalFile(files, target);
    if (current !== undefined && json(ReviewedTeamRule.parse(JSON.parse(current)).rule) === json(rule))
      return { file: target, id, version: digest(current), status: "confirmed" };
    if ((current === undefined ? null : digest(current)) !== draft.previous_version)
      throw new AppError("TEAM_RULE_REVIEW_CONFLICT", "共享规则已被变更，请重新导出并核对两个版本");
    const content = json(ReviewedTeamRule.parse({ rule, reviewer, reviewed_at: new Date().toISOString() }));
    if (current === undefined) await files.create(target, content, 32_768);
    else await files.replace(target, content, current, 32_768);
    return { file: target, id, version: digest(content), status: "confirmed", next_step: "通过业务仓库 PR 审查此规则，撤回时删除相应记录。" };
  } finally { await release(); }
}
