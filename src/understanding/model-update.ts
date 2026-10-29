import { AppError } from "../domain/error.js";
import { ModelContentV2, type ModelV2, type RecordRequest, type SavedModel, type SourceV2 } from "./model-contracts.js";
import { sourcePath } from "./model-evidence.js";

/** 稳定 ID 保持引用一致；更新和删除必须明确，禁止静默丢弃未提交的规则。 */
function mergeItems<T extends { id: string }>(prior: T[], upserts: T[] = [], removed: string[] = []): T[] {
  unique(upserts.map((item) => item.id)); unique(removed);
  if (upserts.some((item) => removed.includes(item.id)) || removed.some((id) => !prior.some((item) => item.id === id))) {
    throw new AppError("PROJECT_MODEL_PATCH_INVALID", "同一条目不能同时更新和删除，删除 ID 必须存在");
  }
  const updated = new Map(upserts.map((item) => [item.id, item]));
  return [...prior.filter((item) => !removed.includes(item.id)).map((item) => updated.get(item.id) ?? item), ...upserts.filter((item) => !prior.some((old) => old.id === item.id))];
}

function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new AppError("PROJECT_MODEL_DUPLICATE", "模型中的 ID、路径或名称不能重复");
}

export function prepareModel(request: RecordRequest, prior: SavedModel | undefined) {
  const patch = request.patch;
  if (patch && prior?.schema_version !== 2) throw new AppError("PROJECT_MODEL_MIGRATION_REQUIRED", "局部修订前需读取旧模型，补齐规则依据并完整迁移到 schema_version: 2");
  if (!patch && prior?.schema_version === 2) throw new AppError("PROJECT_MODEL_PATCH_REQUIRED", "已有新版模型使用 patch 修订，以保留未复核条目及其证据");
  const old = prior?.schema_version === 2 ? prior : undefined;
  const { scan_id, expected_revision, schema_version, revision_reason, patch: ignored, ...body } = request;
  const content = ModelContentV2.parse(patch && old ? {
    id: old.id, module: old.module, title: old.title, scope: old.scope, summary: old.summary,
    entities: old.entities, flows: old.flows, related_paths: old.related_paths, questions: old.questions, ...patch.metadata,
    sources: mergeItems(old.sources, patch.upsert_sources, patch.remove_source_ids),
    rules: mergeItems(old.rules.map(({ evidence_versions, ...rule }) => rule), patch.upsert_rules, patch.remove_rule_ids),
    relations: mergeItems(old.relations.map(({ evidence_versions, rule_versions, target_sha256, target_model_revision, target_rule_versions, entity_versions, target_entity_versions, ...relation }) => relation), patch.upsert_relations, patch.remove_relation_ids),
  } : body);
  for (const values of [content.sources, content.rules, content.relations]) unique(values.map((item) => item.id));
  unique(content.entities.map((item) => item.name)); unique(content.flows.map((item) => item.name));
  if ([...content.entities, ...content.flows].some((item) => !item.name.trim())) throw new AppError("PROJECT_MODEL_NAME", "新版模型的术语和流程需要明确名称");
  unique(content.related_paths); unique(content.scope);
  const sourceMap = new Map(content.sources.map((source) => [source.id, source]));
  for (const source of content.sources) {
    const path = sourcePath(source);
    if (path && !content.related_paths.includes(path)) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "每个文件证据必须包含在 related_paths 中");
  }
  const requireSources = (ids: string[]): SourceV2[] => {
    unique(ids);
    return ids.map((id) => { const source = sourceMap.get(id); if (!source) throw new AppError("PROJECT_MODEL_SOURCE_REFERENCE", `不存在的证据 ID：${id}`); return source; });
  };
  unique(content.entities.flatMap(entity => entity.id ? [entity.id] : []));
  for (const entity of content.entities) {
    if (entity.source_ids) requireSources(entity.source_ids);
    if (entity.aliases?.length && (!entity.id || !entity.source_ids?.length))
      throw new AppError("PROJECT_MODEL_ENTITY_EVIDENCE", "术语别名需要稳定实体 ID 和明确来源，不能按同名自动合并");
    if (entity.aliases) unique(entity.aliases);
  }
  for (const rule of content.rules) {
    const sources = requireSources(rule.source_ids);
    if (rule.basis === "observed" && !sources.some((source) => source.kind === "code")) throw new AppError("PROJECT_MODEL_BASIS", "代码当前行为至少需要一条代码依据");
    if (rule.basis === "intended" && !sources.some((source) => source.kind !== "code")) throw new AppError("PROJECT_MODEL_BASIS", "需求预期行为需要文档或本项目任务要求作为依据");
  }
  for (const relation of content.relations) {
    requireSources(relation.source_ids); unique(relation.rule_ids);
    if (relation.rule_ids.some((id) => !content.rules.some((rule) => rule.id === id))) throw new AppError("PROJECT_MODEL_RULE_REFERENCE", "业务关系引用了不存在的规则");
    if (!content.related_paths.includes(relation.target_path)) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "业务关系的目标文件须包含在 related_paths 中");
    if (relation.target_model_id === content.id) throw new AppError("PROJECT_MODEL_RELATION_INVALID", "本模型内通过 rule_ids 引用规则，无需引用自身模型");
    if (relation.entity_ids?.some(id => !content.entities.some(entity => entity.id === id)))
      throw new AppError("PROJECT_MODEL_ENTITY_REFERENCE", "关系引用了不存在的本地实体 ID");
    if ((relation.target_rule_ids || relation.target_entity_ids) && !relation.target_model_id)
      throw new AppError("PROJECT_MODEL_RELATION_TARGET", "跨模型实体或规则引用必须指定 target_model_id");
    for (const ids of [relation.entity_ids, relation.target_entity_ids, relation.target_rule_ids]) if (ids) unique(ids);
  }
  return {
    content, old,
    reviewedRules: new Set((patch ? patch.upsert_rules ?? [] : content.rules).map((item) => item.id)),
    reviewedRelations: new Set((patch ? patch.upsert_relations ?? [] : content.relations).map((item) => item.id)),
    updatedSources: new Set((patch ? patch.upsert_sources ?? [] : content.sources).map((item) => item.id)),
  };
}

/** 未重核的规则保持旧指纹；查询时逐条报告过期，不把局部修订伪装成整份已核验。 */
export function priorRule(model: ModelV2 | undefined, id: string) { return model?.rules.find((rule) => rule.id === id); }
export function priorRelation(model: ModelV2 | undefined, id: string) { return model?.relations.find((relation) => relation.id === id); }
