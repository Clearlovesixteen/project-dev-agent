import { opendir } from "node:fs/promises";
import { AppError } from "../domain/error.js";
import { RelativePathSchema, type Source } from "../domain/common.js";
import type { Knowledge } from "../domain/knowledge.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { loadConfig, type ProjectConfig } from "./config.js";
import { digest, parseKnowledge } from "./document.js";

export interface Diagnostic { code: string; message: string }
export interface KnowledgeEntry { file: string; version: string; knowledge: Knowledge }
export interface SourceState { reference: string; state: "current" | "changed" | "missing" | "untracked" | "attested" | "unverifiable"; message?: string }

export async function loadKnowledge(files: ProjectFiles): Promise<{ config: ProjectConfig; defaulted: boolean; entries: KnowledgeEntry[]; diagnostics: Diagnostic[] }> {
  const { config, defaulted } = await loadConfig(files);
  const entries: KnowledgeEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  let count = 0;
  let bytes = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 4) throw new AppError("KNOWLEDGE_LIMIT", "知识目录的嵌套深度超过四层");
    const directory = await opendir(await files.path(relative));
    for await (const entry of directory) {
      if (++count > 400) throw new AppError("KNOWLEDGE_LIMIT", "知识目录超过 400 个条目");
      const child = `${relative}/${entry.name}`;
      try {
        if (entry.isSymbolicLink()) throw new AppError("PATH_UNSAFE", `知识路径不能使用符号链接：${child}`);
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.name.endsWith(".md")) {
          const text = await files.read(child);
          bytes += Buffer.byteLength(text);
          if (bytes > 2_000_000 || entries.length >= 200) throw new AppError("KNOWLEDGE_LIMIT", "知识超过 200 份文档或 2 MB");
          entries.push({ file: child, version: digest(text), knowledge: parseKnowledge(text) });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === "KNOWLEDGE_LIMIT") throw error;
        diagnostics.push({ code: "KNOWLEDGE_FILE_INVALID", message: `${child}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  try { await walk(config.knowledge_dir, 0); } catch (error) {
    // A first-use repository has no configured library. An explicitly configured missing directory is still a diagnostic.
    if (!(defaulted && hasCode(error, "ENOENT"))) {
      diagnostics.push({ code: hasCode(error, "ENOENT") ? "KNOWLEDGE_DIRECTORY_MISSING" : error instanceof AppError ? error.code : "KNOWLEDGE_READ_FAILED",
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  const occurrences = new Map<string, number>();
  for (const entry of entries) occurrences.set(entry.knowledge.id, (occurrences.get(entry.knowledge.id) ?? 0) + 1);
  for (const [id, number] of occurrences) if (number > 1) diagnostics.push({ code: "DUPLICATE_KNOWLEDGE_ID", message: `已排除使用重复 ID ${id} 的全部 ${number} 份文档` });
  return { config, defaulted, entries: entries.filter((entry) => occurrences.get(entry.knowledge.id) === 1).sort((a, b) => a.file.localeCompare(b.file)), diagnostics };
}

export function sourcePath(source: Source): string | undefined {
  if (source.kind === "experience") return undefined;
  // Optional line or document anchors do not narrow the content snapshot.
  const path = source.reference.replace(/:\d+(?:-\d+)?$/, "").split("#")[0]!;
  if (!RelativePathSchema.safeParse(path).success || /[\*?]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  return path;
}

export async function sourceStates(files: ProjectFiles, knowledge: Knowledge): Promise<SourceState[]> {
  return Promise.all(knowledge.sources.map(async (source): Promise<SourceState> => {
    if (source.kind === "experience") return { reference: source.reference, state: "attested", message: "来源为人工审查记录，无法仅凭代码独立验证" };
    const path = sourcePath(source);
    if (!path) return { reference: source.reference, state: "unverifiable", message: "请使用本地仓库中的文件作为来源，并提供相对路径" };
    try {
      const version = digest(await files.read(path, 1_000_000));
      return { reference: source.reference, state: !source.sha256 ? "untracked" : source.sha256 === version ? "current" : "changed" };
    } catch (error) {
      return { reference: source.reference, state: hasCode(error, "ENOENT") ? "missing" : "unverifiable",
        message: error instanceof Error ? error.message : String(error) };
    }
  }));
}

export async function snapshotSources(files: ProjectFiles, sources: Source[]): Promise<Source[]> {
  return Promise.all(sources.map(async (source) => {
    if (source.kind === "experience") return source;
    const path = sourcePath(source);
    if (!path) throw new AppError("SOURCE_UNVERIFIABLE", `无法为来源生成快照：${source.reference}`);
    return { ...source, sha256: digest(await files.read(path, 1_000_000)) };
  }));
}
