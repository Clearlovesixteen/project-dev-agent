import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { AppError } from "../domain/error.js";
import { KnowledgeSchema, type Knowledge } from "../domain/knowledge.js";

export function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export function parseYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, stringKeys: true, schema: "core", version: "1.2", prettyErrors: false });
  if (document.errors.length || document.warnings.length) {
    throw new AppError("INVALID_YAML", [...document.errors, ...document.warnings].map((error) => error.message).join("; "));
  }
  // Knowledge files do not need aliases or custom tags. Bound expansion explicitly.
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

export function parseKnowledge(text: string): Knowledge {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n\s*## 规则\n([\s\S]*?)\n## 原因\n([\s\S]*)$/.exec(normalized);
  if (!match) throw new AppError("INVALID_KNOWLEDGE", "文档需要 YAML 元数据头，后面包含“## 规则”和“## 原因”章节");
  const metadata = parseYaml(match[1]!);
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
    || Object.hasOwn(metadata, "rule") || Object.hasOwn(metadata, "rationale")) {
    throw new AppError("INVALID_KNOWLEDGE", "文档元数据头必须为键值映射；规则和原因请写在 Markdown 正文章节中");
  }
  return KnowledgeSchema.parse({ ...metadata, rule: match[2]!.trim(), rationale: match[3]!.trim() });
}

export function renderKnowledge(input: Knowledge): string {
  const { rule, rationale, ...metadata } = KnowledgeSchema.parse(input);
  const content = `---\n${stringify(metadata, { lineWidth: 0 })}---\n\n## 规则\n${rule}\n\n## 原因\n${rationale}\n`;
  if (Buffer.byteLength(content) > 32_768) throw new AppError("KNOWLEDGE_LIMIT", "知识文档不能超过 32 KiB");
  return content;
}
