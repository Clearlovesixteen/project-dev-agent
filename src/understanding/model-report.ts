import { escapeHtml as e } from "../history/report.js";
import { responsibilityLabels } from "../report-labels.js";
import type { SavedModel } from "./model-contracts.js";

const basisLabels = { observed: "代码当前行为", intended: "需求预期行为", inferred: "待核实推断" };
const relationLabels = { enforced_by: "规则实施位置", used_by: "规则使用位置", depends_on: "业务依赖" };

/** 报告只展示保存时的模型；实时有效性通过 project_context 核对，所有原文均转义。 */
export function modelCard(model: SavedModel): string {
  const rules = model.rules.map((item) => `<li>${e(responsibilityLabels[item.responsibility])}：${e(item.description)}${"basis" in item
    ? `<p>${e(basisLabels[item.basis])} · 规则 ${e(item.id)}</p><p>适用条件：${e(item.conditions.join("；"))}</p><p>异常条件：${e(item.exceptions.join("；") || "未记录；不代表不存在异常")}</p><p>依据：${e(item.source_ids.join("，"))}</p>` : ""}</li>`).join("");
  const relations = model.schema_version === 2 ? model.relations.map((item) => `<li>${e(relationLabels[item.kind])}：${e(item.target_path)} · ${e(item.reason)}<p>规则：${e(item.rule_ids.join("，"))}${item.target_model_id ? ` · 关联模型：${e(item.target_model_id)}` : ""}</p></li>`).join("") : "";
  const sources = model.sources.map((source) => `<blockquote>${e(source.quote)}<small>${"id" in source ? `${e(source.id)} · ` : ""}${"path" in source
    ? `${e(source.path)}:${source.line}` : `任务 ${e(source.task_id)}${source.correction_id ? ` · 纠正 ${e(source.correction_id)}` : " · 原始需求"}`} · ${e(source.sha256?.slice(0, 12) ?? "待核对")}</small></blockquote>`).join("");
  return `<article><small>模块理解候选 · 修订 ${model.revision}${model.schema_version === 2 ? " · 逐条依据" : " · 旧版模型"}</small><h2>${e(model.title)}</h2><p>${e(model.summary)}</p><p>范围：${e(model.scope.join("，"))}</p><details><summary>术语、流程、规则、关系与依据</summary><ul>${model.entities.map((item) => `<li>${e(item.name)}：${e(item.meaning)}</li>`).join("")}${model.flows.map((item) => `<li>${e(item.name)}：${e(item.steps.join(" → "))}</li>`).join("")}${rules}${relations}</ul>${sources}<ul>${model.questions.map((item) => `<li>${e(item)}</li>`).join("")}</ul></details></article>`;
}
