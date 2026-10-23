import { z } from "zod";
import { RelativePathSchema, TextSchema } from "../domain/common.js";
import type { Knowledge } from "../domain/knowledge.js";
import type { ToolResult } from "../domain/result.js";
import { ProjectFiles } from "../storage/project-files.js";
import { matchesPath, type ProjectConfig } from "./config.js";
import { loadKnowledge, sourceStates } from "./repository.js";

export const KnowledgeSearchInputSchema = z.object({
  query: z.string().trim().max(2_000).default(""),
  modules: z.array(TextSchema).max(30).default([]),
  paths: z.array(RelativePathSchema).max(100).default([]),
  include_unconfirmed: z.boolean().default(false),
  limit: z.number().int().min(1).max(10).default(5),
}).strict().superRefine((input, ctx) => {
  if (!input.query && !input.modules.length && !input.paths.length) ctx.addIssue({ code: "custom", message: "请提供查询内容、模块或受影响的路径" });
});

function scopeMatch(knowledge: Knowledge, modules: string[], paths: string[], config: ProjectConfig): boolean {
  if (modules.length && knowledge.modules.length && !knowledge.modules.some((module) => modules.includes(module))) return false;
  if (paths.length) {
    if (knowledge.paths.length && !knowledge.paths.some((pattern) => paths.some((path) => matchesPath(pattern, path)))) return false;
    if (!knowledge.paths.length && knowledge.modules.length) {
      const owners = config.modules.filter((module) => module.paths.some((pattern) => paths.some((path) => matchesPath(pattern, path)))).map((module) => module.name);
      if (!owners.some((name) => knowledge.modules.includes(name))) return false;
    }
  }
  if (modules.length && !paths.length && !knowledge.modules.length && knowledge.paths.length) {
    // A path-only rule cannot be assumed to belong to an unrelated named module.
    const patterns = config.modules.filter((module) => modules.includes(module.name)).flatMap((module) => module.paths);
    if (!knowledge.paths.some((path) => patterns.some((pattern) => matchesPath(pattern, path)))) return false;
  }
  return true;
}

/** 解释现有范围过滤，不把关键词命中、确认状态或来源有效误写成适用条件已成立。 */
function matchExplanation(knowledge: Knowledge, modules: string[], paths: string[], config: ProjectConfig, terms: string[]) {
  const owners = config.modules.filter(module => module.paths.some(pattern => paths.some(path => matchesPath(pattern, path))));
  const matched_paths = knowledge.paths.flatMap(pattern => paths.filter(path => matchesPath(pattern, path)).map(path => ({ pattern, path })));
  const matched_modules = knowledge.modules.filter(module => modules.includes(module) || !knowledge.paths.length && owners.some(owner => owner.name === module));
  const module_path_matches = modules.length && !paths.length && !knowledge.modules.length
    ? config.modules.filter(module => modules.includes(module.name)).flatMap(module => knowledge.paths.flatMap(path => module.paths.filter(pattern => matchesPath(pattern, path)).map(pattern => ({ module: module.name, pattern, rule_path: path })))) : [];
  return { matched_paths: matched_paths.slice(0, 20), matched_modules: matched_modules.slice(0, 20), module_path_matches: module_path_matches.slice(0, 20),
    matched_terms: terms, truncated: matched_paths.length > 20 || matched_modules.length > 20 || module_path_matches.length > 20,
    condition_check: "required", explanation: "范围匹配用于筛选，关键词用于排序；使用前仍需结合本任务核对适用条件。来源有效和已确认状态不代表本任务已满足条件。" };
}

export async function searchKnowledge(files: ProjectFiles, input: unknown): Promise<ToolResult> {
  const request = KnowledgeSearchInputSchema.parse(input);
  const { config, defaulted, entries, diagnostics } = await loadKnowledge(files);
  const paths = request.paths.filter((path) => !config.exclude_paths.some((pattern) => matchesPath(pattern, path)));
  if (request.paths.length && !paths.length) return { outcome: "ok", code: "PATHS_EXCLUDED", data: { results: [], notices: [], truncated: false }, diagnostics: [] };
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const terms = [...new Set([...segmenter.segment(request.query.toLowerCase())].filter((part) => part.isWordLike).map((part) => part.segment))].slice(0, 50);
  const ranked = entries.filter(({ knowledge }) => knowledge.status !== "disabled" && scopeMatch(knowledge, request.modules, paths, config)).map((entry) => {
    const { knowledge } = entry;
    const haystack = [knowledge.title, knowledge.rule, knowledge.rationale, ...knowledge.applicable_conditions, ...knowledge.modules, ...knowledge.paths].join("\n").toLowerCase();
    const hits = terms.filter((term) => haystack.includes(term));
    return { ...entry, matched_terms: hits, score: hits.length };
  }).filter((entry) => !terms.length || paths.length || request.modules.length || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.knowledge.id.localeCompare(b.knowledge.id));
  const results: unknown[] = [];
  const notices: unknown[] = [];
  let resultBytes = 0;
  let truncated = false;
  let eligible = 0;
  for (const entry of ranked) {
    const states = await sourceStates(files, entry.knowledge);
    const stale = states.some((state) => !["current", "attested"].includes(state.state));
    const status = entry.knowledge.status === "confirmed" && stale ? "needs_review" : entry.knowledge.status;
    const effective = status === "confirmed";
    if (!effective) notices.push({ id: entry.knowledge.id, file: entry.file, status, source_status: states });
    if (!effective && !request.include_unconfirmed) continue;
    eligible++;
    const value = { ...entry.knowledge, status, recorded_status: entry.knowledge.status, effective,
      file: entry.file, version: entry.version, source_status: states, matched_terms: entry.matched_terms,
      match_explanation: matchExplanation(entry.knowledge, request.modules, paths, config, entry.matched_terms),
      applicability: "范围和关键词仅用于检索；使用前，请结合当前任务核对 applicable_conditions 中的适用条件。" };
    const size = Buffer.byteLength(JSON.stringify(value));
    if (results.length >= request.limit || resultBytes + size > 48_000) { truncated = true; continue; }
    results.push(value);
    resultBytes += size;
  }
  return { outcome: diagnostics.length ? "incomplete" : "ok", code: diagnostics.length ? "KNOWLEDGE_PARTIAL" : "KNOWLEDGE_SEARCHED",
    data: { results, notices: notices.slice(0, 20), notices_truncated: notices.length > 20, eligible_count: eligible, truncated,
      knowledge_directory: config.knowledge_dir, configuration: defaulted ? "defaults" : "project",
      next_step: entries.length === 0 ? "未找到可复用的规则。请阅读现有项目说明、相关文档和参考实现，不要编造已确认的规则。" : null }, diagnostics };
}
