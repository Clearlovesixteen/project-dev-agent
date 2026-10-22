import { AppError } from "../domain/error.js";
import { digest } from "../knowledge/document.js";
import type { ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import { TaskStore } from "../storage/task-store.js";
import type { MapFile } from "./contracts.js";
import type { SourceV2, SavedModel, RuleV2 } from "./model-contracts.js";
import { excluded, safeSource } from "./scan.js";

type Source = SavedModel["sources"][number];
export const sourcePath = (source: Source): string | undefined => "path" in source ? source.path : undefined;

/** 源码、文档原文及引用位置都参与指纹；只改证据说明也不能刷新未复核规则。 */
export function sourceFingerprint(source: SourceV2): string {
  return digest(JSON.stringify(source.kind === "task"
    ? [source.id, source.kind, source.task_id, source.correction_id ?? null, source.quote, source.sha256]
    : [source.id, source.kind, source.path, source.line, source.quote, source.sha256]));
}

export function ruleFingerprint(rule: RuleV2): string {
  return digest(JSON.stringify([rule.id, rule.description, rule.responsibility, rule.basis, rule.conditions, rule.exceptions, rule.source_ids]));
}

/** 单次查询或修订共用读取缓存，避免同一来源被每条规则反复读取。 */
export class ModelEvidence {
  private readonly fileCache = new Map<string, Promise<string>>();
  private readonly taskCache = new Map<string, Promise<string>>();
  constructor(private readonly files: ProjectFiles, private readonly config: ProjectConfig, private readonly entries: Map<string, MapFile>, private readonly repoIdentity: string) {}

  private file(path: string): Promise<string> {
    let value = this.fileCache.get(path);
    if (!value) { value = safeSource(this.files, path, this.config); this.fileCache.set(path, value); }
    return value;
  }

  private task(source: Extract<SourceV2, { kind: "task" }>): Promise<string> {
    const key = JSON.stringify([source.task_id, source.correction_id ?? null]);
    let value = this.taskCache.get(key);
    if (!value) {
      value = (async () => {
        const task = await new TaskStore(this.files.root).load(source.task_id);
        if (task.worktree_path !== this.files.root || task.repo_identity !== this.repoIdentity) throw new AppError("PROJECT_MODEL_TASK_SCOPE", "任务依据必须属于当前仓库及工作区");
        if (!source.correction_id) return task.requirement;
        const correction = task.corrections.find((item) => item.id === source.correction_id);
        if (!correction) throw new AppError("PROJECT_MODEL_TASK_SOURCE", "未找到所引用的任务纠正记录");
        return `${correction.description}\n${correction.rationale}`;
      })();
      this.taskCache.set(key, value);
    }
    return value;
  }

  /** 返回实际文件版本，只允许当前索引覆盖的真实文件。 */
  async currentPath(path: string): Promise<string> {
    const entry = this.entries.get(path);
    if (!entry || digest(await this.file(path)) !== entry.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", `关联文件未索引或已变化，请重新扫描并核对：${path}`);
    return entry.sha256;
  }

  async pathState(path: string, expected: string): Promise<string> {
    if (excluded(path, this.config)) return "missing_or_excluded";
    try { return digest(await this.file(path)) === expected ? "current" : "changed"; }
    catch { return "missing_or_unreadable"; }
  }

  async sourceState(source: Source): Promise<string> {
    if ("path" in source) return this.pathState(source.path, source.sha256);
    try {
      const text = await this.task(source);
      return source.sha256 === digest(text) && text.includes(source.quote) ? "current" : "changed";
    } catch { return "missing_or_unreadable"; }
  }

  /** 保存前核对准确原文；任务证据由服务补充原文哈希，不能凭空声明用户已确认。 */
  async validate<T extends Source>(source: T): Promise<T> {
    if (!("path" in source)) {
      const text = await this.task(source), hash = digest(text);
      if (!text.includes(source.quote)) throw new AppError("PROJECT_MODEL_EVIDENCE_INVALID", "引用原文不在指定的任务需求或纠正记录中");
      if (source.sha256 !== undefined && source.sha256 !== hash) throw new AppError("PROJECT_SOURCE_CHANGED", "任务来源已变化，请核对当前任务记录");
      return { ...source, sha256: hash };
    }
    const hash = await this.currentPath(source.path), text = await this.file(source.path);
    if (hash !== source.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "证据必须与当前索引中的文件哈希一致");
    // 路径角色只是导航提示：HTML/XML/配置既可能是实现，也可能是业务文档，不能据目录名硬判。
    const isMarkdown = /\.(?:md|mdx)$/i.test(source.path);
    const isProgram = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|java|kt|cs|rs|sql)$/i.test(source.path);
    if ("kind" in source && ((isMarkdown && source.kind !== "document") || (isProgram && source.kind !== "code"))) {
      throw new AppError("PROJECT_MODEL_SOURCE_KIND", "Markdown 使用 document，程序源码使用 code；其他文本格式按实际用途标注");
    }
    const snippet = text.split("\n").slice(source.line - 1, source.line - 1 + source.quote.split("\n").length).join("\n");
    if (!snippet.includes(source.quote)) throw new AppError("PROJECT_MODEL_EVIDENCE_INVALID", "引用原文必须出现在所提供的源码行号处");
    return source;
  }
}
