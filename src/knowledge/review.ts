import { AppError } from "../domain/error.js";
import { TextSchema } from "../domain/common.js";
import { KnowledgeSchema } from "../domain/knowledge.js";
import { bindWorktree } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { loadConfig } from "./config.js";
import { digest, parseKnowledge, renderKnowledge } from "./document.js";
import { loadKnowledge, snapshotSources } from "./repository.js";

/** Explicit local reviewer action. This is intentionally not exposed as an MCP tool. */
export async function reviewKnowledge(project: string, file: string, reviewer: string) {
  const binding = await bindWorktree(project);
  const files = new ProjectFiles(binding.root);
  const { config } = await loadConfig(files);
  await files.path(file);
  const shared = file.startsWith(`${config.knowledge_dir}/`);
  if (!file.endsWith(".md") || (!shared && !file.startsWith(".project-dev/local/proposals/"))) {
    throw new AppError("REVIEW_PATH_INVALID", "请审查已配置知识目录或本地提案目录中的 Markdown 文件");
  }
  const previous = await files.read(file);
  const knowledge = parseKnowledge(previous);
  if (knowledge.status === "disabled") throw new AppError("KNOWLEDGE_DISABLED", "请先明确将已停用规则改为候选，再进行审查");
  if (knowledge.review_questions.length) throw new AppError("REVIEW_QUESTIONS_OPEN", "确认前，请解决草稿中的待审查问题，并清空 review_questions");
  const existing = await loadKnowledge(files);
  if (existing.entries.some((entry) => entry.knowledge.id === knowledge.id && entry.file !== file)
    || existing.diagnostics.some((diagnostic) => diagnostic.code === "DUPLICATE_KNOWLEDGE_ID")) {
    throw new AppError("KNOWLEDGE_ID_EXISTS", "请修改现有共享规则，避免创建相同 ID 的副本");
  }
  const confirmed = KnowledgeSchema.parse({ ...knowledge, status: "confirmed", confirmed_by: TextSchema.parse(reviewer),
    reviewed_at: new Date().toISOString(), sources: await snapshotSources(files, knowledge.sources) });
  const target = shared ? file : `${config.knowledge_dir}/${confirmed.id}.md`;
  const content = renderKnowledge(confirmed);
  if (shared) await files.replace(target, content, previous);
  else await files.create(target, content);
  return { file: target, id: confirmed.id, version: digest(content), status: confirmed.status,
    next_step: "请检查知识文档的差异，并按团队 Git 流程完成审查。本操作未提交或推送代码。" };
}
