import type { Knowledge } from "../domain/knowledge.js";
import { bindWorktree } from "../git/baseline.js";
import { modelVisible, worktreeModel } from "../project-knowledge/model-visibility.js";
import { readProjectKnowledge, type ProjectKnowledgeStatus } from "../project-knowledge/service.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { CodeBindingResolver } from "../understanding/code-bindings.js";
import { ruleFingerprint } from "../understanding/model-evidence.js";
import type { ProjectConfig } from "./config.js";
import type { SourceState } from "./repository.js";
import type { TeamRule } from "./team-rule-contract.js";

/** 仅在一次查询中保存源码检查结果和模型视图，下一次查询重新核验当前工作树。 */
export class TeamRuleVerifier {
  private readonly anchors: CodeBindingResolver;
  private view?: Promise<ProjectKnowledgeStatus>;
  constructor(private readonly files: ProjectFiles, private readonly config: ProjectConfig, private readonly loadView?: () => Promise<ProjectKnowledgeStatus>) {
    this.anchors = new CodeBindingResolver(files, config);
  }

  /** 先核对 Git 记录列出的每个相对锚点，再检查本机是否已经有冲突的模型解释。 */
  async check(rule: TeamRule, knowledge: Knowledge): Promise<SourceState[]> {
    const states = await Promise.all(rule.sources.map((source, i) => this.checkAnchor(knowledge.sources[i]!.reference, source)));
    if (states.some(source => source.state !== "current")) return states;
    const reference = `model:${rule.model_id}#${rule.rule_id}`;
    try {
      this.view ??= this.loadView ? this.loadView() : bindWorktree(this.files.root).then(readProjectKnowledge);
      const conflict = this.modelConflict(await this.view, rule, reference);
      return conflict ? [...states, conflict] : states;
    } catch (error) { return [...states, failedSource(reference, error)]; }
  }

  /** 同一文件多处引用只读取一次，符号锚点须在当前工作树唯一匹配。 */
  private async checkAnchor(reference: string, source: TeamRule["sources"][number]): Promise<SourceState> {
    try {
      const file = await this.anchors.source(source.path);
      if (source.sha256 !== file.sha256) return { reference, state: "changed", message: "本树文件内容与审查版本不同" };
      if (source.line && source.line > file.text.split("\n").length)
        return { reference, state: "unverifiable", message: "当前文件中找不到审查记录指定的行" };
      if (source.symbol) {
        const binding = await this.anchors.resolve({ id: "check", role: "enforces", source_ids: ["approved"], path: source.path, symbol: source.symbol });
        if (binding.resolution !== "resolved") return { reference, state: "unverifiable", message: "当前文件不能唯一定位审核记录指定的符号" };
      }
      return { reference, state: "current" };
    } catch (error) { return failedSource(reference, error); }
  }

  /** 新 clone 允许直接核验代码。已建模的工作树遇到同一规则的差异时等待复查。 */
  private modelConflict(view: ProjectKnowledgeStatus, rule: TeamRule, reference: string): SourceState | undefined {
    const module = view.modules?.find(item => item.model_id === rule.model_id);
    if (view.state === "unavailable" || view.state === "unverified" || (module && module.state !== "matched"))
      return { reference, state: "unverifiable", message: "本工作树模型尚未完成核验或存在分歧，请复查这条团队规则" };
    if (!module) return;
    const snapshot = view.selected_models?.find(item => item.model_id === rule.model_id);
    const model = worktreeModel(this.files.root, snapshot?.content, rule.model_id);
    const local = model && modelVisible(model, this.config) && model.schema_version !== 1 ? model.rules.find(item => item.id === rule.rule_id) : undefined;
    if (!local || model?.module !== rule.module || rule.description !== local.description ||
        JSON.stringify([rule.conditions, rule.exceptions]) !== JSON.stringify([local.conditions, local.exceptions]) ||
        rule.rule_fingerprint !== ruleFingerprint({ ...local, source_ids: [] }))
      return { reference, state: "changed", message: "本工作树的同名模型规则与团队审查版本存在差异，请核对条件、例外和适用范围" };
  }
}

/** 文件缺失与其他读取失败保留不同原因，均不能使候选成为约束。 */
function failedSource(reference: string, error: unknown): SourceState {
  return { reference, state: hasCode(error, "ENOENT") ? "missing" : "unverifiable", message: error instanceof Error ? error.message : String(error) };
}
