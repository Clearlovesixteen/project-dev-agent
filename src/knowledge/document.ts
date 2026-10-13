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
  if (!match) throw new AppError("INVALID_KNOWLEDGE", "Expected YAML front matter followed by sections '## 规则' and '## 原因'");
  const metadata = parseYaml(match[1]!);
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
    || Object.hasOwn(metadata, "rule") || Object.hasOwn(metadata, "rationale")) {
    throw new AppError("INVALID_KNOWLEDGE", "Front matter must be a mapping; put rule and rationale in the Markdown sections");
  }
  return KnowledgeSchema.parse({ ...metadata, rule: match[2]!.trim(), rationale: match[3]!.trim() });
}

export function renderKnowledge(input: Knowledge): string {
  const { rule, rationale, ...metadata } = KnowledgeSchema.parse(input);
  const content = `---\n${stringify(metadata, { lineWidth: 0 })}---\n\n## 规则\n${rule}\n\n## 原因\n${rationale}\n`;
  if (Buffer.byteLength(content) > 32_768) throw new AppError("KNOWLEDGE_LIMIT", "Knowledge documents must fit within 32 KiB");
  return content;
}
