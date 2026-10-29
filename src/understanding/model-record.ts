import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "../git/index.js";
import { gitLine, readGit } from "../git/command.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { ProjectFiles } from "../storage/project-files.js";
import { MAP_DIR } from "./contracts.js";
import { LegacyContent, SavedLegacyModel, SavedModelV2, type RecordRequest, type SavedModel } from "./model-contracts.js";
import { ModelEvidence, dependencyFingerprint, entityFingerprint, ruleFingerprint, sourceFingerprint, sourcePath } from "./model-evidence.js";
import { prepareModel, priorRelation, priorRule } from "./model-update.js";
import { excluded, mapConfigHash } from "./scan.js";
import { mapFiles, modelIndex, models, optional, readMap, save } from "./store.js";

/** 调用方持有理解目录写锁。先校验证据和引用，最后才发布不可变修订及索引。 */
export async function recordModel(files: ProjectFiles, binding: WorktreeBinding, request: RecordRequest): Promise<SavedModel> {
  const map = await readMap(files), { config } = await loadConfig(files);
  if (!map || map.scan_id !== request.scan_id || map.repo_identity !== binding.repo_identity || map.config_hash !== await mapConfigHash(files, config)
    || map.head !== gitLine((await readGit(files.root, ["rev-parse", "HEAD"])).stdout)) {
    throw new AppError("PROJECT_MAP_CHANGED", "记录模型前，请先读取当前配置、HEAD 和项目结构索引");
  }
  const index = await modelIndex(files), existing = await models(files), prior = existing.find((model) => model.id === request.id);
  if ((prior?.revision ?? 0) !== request.expected_revision) throw new AppError("PROJECT_MODEL_REVISION_CONFLICT", "更新前请读取模型最新修订，保留其他修改");
  if (!prior && index.length >= 200) throw new AppError("PROJECT_MODEL_LIMIT", "当前工作区已有 200 个模型");
  if (prior?.schema_version === 2 && request.schema_version !== 2) throw new AppError("PROJECT_MODEL_DOWNGRADE", "新版模型不能降级覆盖，请使用 schema_version: 2 和 patch");
  const entries = new Map((await mapFiles(files)).map((entry) => [entry.path, entry]));
  const evidence = new ModelEvidence(files, config, entries, binding.repo_identity);
  const metadata = { project: binding.root, scan_id: request.scan_id, revision: request.expected_revision + 1, recorded_at: new Date().toISOString() };
  let model: SavedModel;
  if (request.schema_version !== 2) {
    const { scan_id, expected_revision, schema_version, revision_reason, patch, ...body } = request;
    const content = LegacyContent.parse(body);
    const related_versions = [];
    for (const path of content.related_paths) related_versions.push({ path, sha256: await evidence.currentPath(path) });
    for (const source of content.sources) {
      if (!content.related_paths.includes(source.path)) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "请在 related_paths 中包含每个证据文件");
      await evidence.validate(source);
    }
    model = SavedLegacyModel.parse({ ...content, ...metadata, schema_version: 1, related_versions });
  } else {
    const { content, old, reviewedRules, reviewedRelations, updatedSources } = prepareModel(request, prior);
    if (content.related_paths.some((path) => excluded(path, config))) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "不能记录配置已排除的模型来源");
    const sources = new Map(content.sources.map((source) => [source.id, source]));
    const validated = new Set<string>();
    const validateSource = async (id: string) => {
      if (!validated.has(id)) { sources.set(id, await evidence.validate(sources.get(id)!)); validated.add(id); }
    };
    for (const id of updatedSources) await validateSource(id);
    const versions = async (ids: string[]) => {
      for (const id of ids) await validateSource(id);
      return ids.map((id) => ({ id, fingerprint: sourceFingerprint(sources.get(id)!) }));
    };
    const rules = [];
    for (const rule of content.rules) rules.push(reviewedRules.has(rule.id)
      ? { ...rule, evidence_versions: await versions(rule.source_ids) } : priorRule(old, rule.id)!);
    const relations = [];
    for (const relation of content.relations) {
      if (!reviewedRelations.has(relation.id)) { relations.push(priorRelation(old, relation.id)!); continue; }
      const target = relation.target_model_id ? existing.find((item) => item.id === relation.target_model_id) : undefined;
      if (relation.target_model_id && (!target || target.related_paths.some((path) => excluded(path, config)))) {
        throw new AppError("PROJECT_MODEL_RELATION_TARGET", "引用的业务模型不存在或已排除；先查询可用模型");
      }
      if (relation.target_rule_ids && (!target || target.schema_version !== 2 || relation.target_rule_ids.some(id => !target.rules.some(rule => rule.id === id))))
        throw new AppError("PROJECT_MODEL_TARGET_RULE", "目标规则 ID 不存在，不能保存虚构的关联");
      if (relation.target_entity_ids?.some(id => !target?.entities.some(entity => entity.id === id)))
        throw new AppError("PROJECT_MODEL_ENTITY_REFERENCE", "目标实体 ID 不存在");
      relations.push({ ...relation, evidence_versions: await versions(relation.source_ids),
        rule_versions: relation.rule_ids.map((id) => ({ id, fingerprint: ruleFingerprint(content.rules.find((rule) => rule.id === id)!) })),
        target_sha256: await evidence.currentPath(relation.target_path),
        ...(target ? { target_model_revision: target.revision } : {}),
        ...(relation.entity_ids ? { entity_versions: relation.entity_ids.map(id => ({ id,
          fingerprint: entityFingerprint(content.entities.find(entity => entity.id === id)!, [...sources.values()]) })) } : {}),
        ...(target?.schema_version === 2 && relation.target_entity_ids ? { target_entity_versions: relation.target_entity_ids.map(id => ({ id,
          fingerprint: entityFingerprint(target.entities.find(entity => entity.id === id)!, target.sources) })) } : {}),
        ...(target?.schema_version === 2 && relation.target_rule_ids ? { target_rule_versions: relation.target_rule_ids.map(id => ({ id,
          fingerprint: dependencyFingerprint(target.rules.find(rule => rule.id === id)!) })) } : {}) });
    }
    const refreshed = new Set([...validated].flatMap((id) => { const path = sourcePath(sources.get(id)!); return path ? [path] : []; }));
    for (const relation of content.relations) if (reviewedRelations.has(relation.id)) refreshed.add(relation.target_path);
    const related_versions = [];
    for (const path of content.related_paths) {
      const previous = old?.related_versions.find((item) => item.path === path);
      related_versions.push(previous && !refreshed.has(path) ? previous : { path, sha256: await evidence.currentPath(path) });
    }
    model = SavedModelV2.parse({ ...content, ...metadata, schema_version: 2, revision_reason: request.revision_reason,
      sources: [...sources.values()], rules, relations, related_versions });
  }
  const raw = JSON.stringify(model) + "\n", hash = digest(raw), path = `${MAP_DIR}/models/${hash}.json`;
  if (Buffer.byteLength(raw) > 65_536) throw new AppError("FILE_LIMIT", "模型超过 64 KiB，请按业务能力拆分并通过 target_model_id 复用公共模型");
  if (await optional(files, path) === undefined) await files.create(path, raw);
  await save(files, `${MAP_DIR}/models.json`, [...index.filter((item) => item.id !== model.id), { id: model.id, revision: model.revision, hash }]);
  return model;
}
