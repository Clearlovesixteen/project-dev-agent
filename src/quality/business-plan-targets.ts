import { AppError } from "../domain/error.js";
import type { Task } from "../domain/task.js";
import type { WorktreeBinding } from "../git/index.js";
import { baselineContent } from "../git/workspace-baseline.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { ProjectFiles } from "../storage/project-files.js";
import { CodeBindingResolver } from "../understanding/code-bindings.js";
import { ModelEvidence, dependencyFingerprint, ruleFingerprint, sourceFingerprint } from "../understanding/model-evidence.js";
import { SavedRuleV3, type SavedModel } from "../understanding/model-contracts.js";
import { mapFiles } from "../understanding/store.js";
import { loadSymbolIndex } from "../understanding/load-symbol-index.js";
import { CodeBindingInput, type CodeBinding, type SavedBinding } from "../understanding/semantic-contracts.js";
import type { BusinessPlan, BusinessPlanRecord } from "./business-plan-contracts.js";

export const ruleKey = (ref: { model_id: string; rule_id: string }) => `${ref.model_id}/${ref.rule_id}`;
export const bindingKey = (ref: { model_id: string; rule_id: string; binding_id: string }) => `${ruleKey(ref)}/${ref.binding_id}`;
export const locationKey = (ref: { path: string; symbol?: string | undefined }) => JSON.stringify([ref.path, ref.symbol ?? null]);
export const activeBusinessDeltas = (task: Pick<Task, "business_deltas">) => (task.business_deltas ?? []).filter(record =>
  !task.business_deltas?.some(other => other.input.supersedes_id === record.input.id));

export function bindingInput(binding: SavedBinding): CodeBinding {
  const { resolution, start, end, target_sha256, symbol_sha256, ...input } = binding;
  return input;
}

/** 草案阶段使用预期规则，既有规则的旧绑定也保留，防止省略相关入口就绕过影响核对。 */
export function planRule(all: SavedModel[], task: Task, ref: BusinessPlan["rules"][number]) {
  const model = all.find(candidate => candidate.id === ref.model_id);
  const current = model && model.schema_version !== 1 ? model.rules.find(rule => rule.id === ref.rule_id) : undefined;
  const delta = activeBusinessDeltas(task).find(record => ruleKey(record.input) === ruleKey(ref));
  if (delta?.input.id !== ref.delta_id) throw new AppError("BUSINESS_PLAN_DELTA", "规则须关联当前草案版本，不能用现行规则代替预期或引用失效草案");
  const before = delta ? delta.before_rule : current;
  const observed = before ? SavedRuleV3.parse(before) : undefined;
  const intended = delta?.input.proposed_rule;
  const rule = intended ?? observed;
  if (!rule?.semantics) throw new AppError("BUSINESS_PLAN_RULE", `规则缺少结构化条件及场景：${ruleKey(ref)}`);
  const bindings = new Map<string, CodeBinding>();
  for (const bound of observed?.bindings ?? []) bindings.set(bound.id, bindingInput(bound));
  for (const bound of intended?.bindings ?? []) {
    const previous = bindings.get(bound.id);
    if (previous && (locationKey(previous) !== locationKey(bound) || previous.role !== bound.role))
      throw new AppError("BUSINESS_PLAN_BINDING_ID", "代码位置或角色变化时使用新的绑定 ID，保留旧位置供核对");
    bindings.set(bound.id, CodeBindingInput.parse(bound));
  }
  if (!bindings.size) throw new AppError("BUSINESS_PLAN_BINDING", `规则缺少代码位置：${ruleKey(ref)}`);
  return { model, current, observed, delta, rule: { ...rule, semantics: rule.semantics }, bindings: [...bindings.values()] };
}

/** 用当前规则的有向关系定位必核对入口；沿用模型记录的路径，不用同名文件猜关系。 */
export function relatedPaths(all: SavedModel[], refs: BusinessPlan["rules"]): string[] {
  const rules = new Set(refs.map(ruleKey));
  const ids = new Set(refs.map(ref => ref.model_id));
  const paths = new Set<string>();
  for (const model of all) {
    if (model.schema_version === 1) continue;
    for (const relation of model.relations) {
      const outgoing = relation.rule_ids.some(rule_id => rules.has(ruleKey({ model_id: model.id, rule_id })));
      const incoming = relation.target_model_id && ids.has(relation.target_model_id) && (!relation.target_rule_ids
        || relation.target_rule_ids.some(rule_id => rules.has(ruleKey({ model_id: relation.target_model_id!, rule_id }))));
      if (outgoing || incoming) paths.add(relation.target_path);
      if (incoming) for (const rule of model.rules) if (relation.rule_ids.includes(rule.id)) {
        for (const target of SavedRuleV3.parse(rule).bindings ?? []) paths.add(target.path);
      }
    }
  }
  return [...paths].sort();
}

export async function captureTargets(binding: WorktreeBinding, task: Task, plan: BusinessPlan, all: SavedModel[]) {
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const resolver = new CodeBindingResolver(files, config), { selectSymbol } = await loadSymbolIndex();
  const evidence = new ModelEvidence(files, config, new Map((await mapFiles(files)).map(item => [item.path, item])), binding.repo_identity,
    new Map([[task.id, task]]));
  const baselines = new Map<string, Promise<string>>();
  const prior = task.business_plans?.at(-1);
  const targets: BusinessPlanRecord["targets"] = [];
  for (const ref of plan.rules) {
    const { model, observed, delta, rule, bindings } = planRule(all, task, ref);
    const previous = prior?.targets.find(target => ruleKey(target) === ruleKey(ref));
    if (observed && model && model.schema_version !== 1) {
      if (observed.basis !== "observed") throw new AppError("BUSINESS_PLAN_RULE_BASIS", "当前行为须来自已核对的实际代码");
      for (const version of observed.evidence_versions) {
        const source = model.sources.find(item => item.id === version.id);
        const alreadyChecked = previous?.rule_fingerprint === ruleFingerprint(rule);
        if (!source || sourceFingerprint(source) !== version.fingerprint || !alreadyChecked && await evidence.sourceState(source) !== "current")
          throw new AppError("BUSINESS_PLAN_RULE_STALE", `规则的当前代码依据需要先复核：${ruleKey(ref)}`);
      }
    }
    if (delta) for (const source of delta.input.sources) {
      if (await evidence.sourceState(source) !== "current") throw new AppError("BUSINESS_PLAN_SOURCE_STALE", "预期规则的需求来源已变化，请追加草案修订");
    }
    const captured = [];
    for (const input of bindings) {
      const decision = plan.decisions.find(item => ruleKey(item) === ruleKey(ref) && item.binding_id === input.id);
      if (!decision) throw new AppError("BUSINESS_PLAN_DECISION_REQUIRED", `关联代码位置需要处理决定：${input.id}`);
      const cached = previous?.bindings.find(item => locationKey(item.input) === locationKey(input));
      let baseline = baselines.get(input.path);
      if (!baseline) {
        baseline = baselineContent(binding, task.baseline_head, input.path, task.workspace_baseline);
        baselines.set(input.path, baseline);
      }
      const text = await baseline;
      const initial = cached?.initial ?? await resolver.resolve(input);
      const baselineSymbol = input.symbol ? selectSymbol(input.path, text, input.symbol) : undefined;
      const baselineSymbolHash = baselineSymbol?.resolution === "resolved" ? baselineSymbol.sha256 : null;
      if (decision.action === "modify" && ["reuse", "contract"].includes(input.role) && !input.symbol)
        throw new AppError("BUSINESS_PLAN_SHARED_SCOPE", "公共复用入口和契约不能获得整文件修改范围，请定位具体符号");
      if (decision.action === "modify" && !input.symbol && initial.resolution !== "planned")
        throw new AppError("BUSINESS_PLAN_SYMBOL_REQUIRED", "已有业务代码只允许按可定位的符号修改");
      if (decision.action === "modify" && !["resolved", "planned"].includes(initial.resolution))
        throw new AppError("BUSINESS_PLAN_UNRESOLVED", `待修改位置尚未明确：${input.path}${input.symbol ? `#${input.symbol}` : ""}`);
      if (decision.action !== "modify" && input.planned)
        throw new AppError("BUSINESS_PLAN_BINDING", "尚未创建的位置需要明确修改决定，不能标为已核对或保护");
      captured.push({ input, initial, baseline_sha256: digest(text), baseline_symbol_sha256: baselineSymbolHash });
    }
    targets.push({ model_id: ref.model_id, rule_id: ref.rule_id, rule_fingerprint: ruleFingerprint(rule),
      ...(!delta && observed ? { dependency_fingerprint: dependencyFingerprint(observed) } : {}),
      ...(delta ? { delta_fingerprint: delta.fingerprint } : {}), bindings: captured });
  }
  return targets;
}
