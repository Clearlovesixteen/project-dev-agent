import { z } from "zod";
import { AppError } from "../domain/error.js";
import type { ToolResult } from "../domain/result.js";
import { assertStateIgnored, type WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { MAP_DIR, ModelRecordInput, SavedModelSchema, ScanInput } from "./contracts.js";
import { locked, mapFiles, modelIndex, optional, readMap, save, understandingStatus } from "./store.js";
import { mapConfigHash, safeSource, scanProject } from "./scan.js";
import { projectContext } from "./context.js";
import { renderProjectReport } from "./report.js";
import { readGit, gitLine } from "../git/command.js";

/** 管理结构扫描与业务理解候选；语义内容由 Codex 提交，服务负责核对来源和版本。 */
export class UnderstandingService {
  private readonly files: ProjectFiles;
  constructor(private readonly binding: WorktreeBinding) { this.files = new ProjectFiles(binding.root); }
  private async execute(action: () => Promise<ToolResult>): Promise<ToolResult> {
    try { return await action(); } catch (error) {
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "PROJECT_UNDERSTANDING_INPUT" : "PROJECT_UNDERSTANDING_FAILED";
      return { outcome: "error", code, diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] };
    }
  }
  /** 在本地忽略目录发布结构索引和报告，扫描与模型写入共用锁，避免状态交叉覆盖。 */
  async scan(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      ScanInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const map = await scanProject(this.binding); await renderProjectReport(this.files);
        return { outcome: map.coverage.complete ? "ok" : "incomplete", code: "PROJECT_SCANNED", data: await understandingStatus(this.files), diagnostics: map.diagnostics };
      });
    });
  }
  /** 查询时核验所选来源；需要重扫或覆盖不完整时返回 incomplete，供调用方补充检查。 */
  async context(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const data = await projectContext(this.files, input);
      return { outcome: data.state === "needs_rescan" || data.state === "partial" ? "incomplete" : "ok", code: "PROJECT_CONTEXT", data, diagnostics: [] };
    });
  }
  /** 保存有源码依据的模型候选；引用匹配只证明来源，不把语义结论自动确认为规则。 */
  async record(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = ModelRecordInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const map = await readMap(this.files), { config } = await loadConfig(this.files);
        // 模型必须建立在当前扫描、配置及 HEAD 上，避免把旧上下文的分析写入新快照。
        if (!map || map.scan_id !== request.scan_id || map.repo_identity !== this.binding.repo_identity || map.config_hash !== await mapConfigHash(this.files, config)) throw new AppError("PROJECT_MAP_CHANGED", "记录模型前，请先读取最新的项目结构索引");
        if (map.head !== gitLine((await readGit(this.files.root, ["rev-parse", "HEAD"])).stdout)) throw new AppError("PROJECT_MAP_CHANGED", "HEAD 已变化，请刷新项目结构索引");
        const entries = new Map((await mapFiles(this.files)).map((entry) => [entry.path, entry]));
        // 不仅检查引用文件，也检查所有声明的关联文件，防止遗漏关联来源的变化。
        for (const path of request.related_paths) {
          const entry = entries.get(path);
          if (!entry || digest(await safeSource(this.files, path, config)) !== entry.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "相关文件已缺失或发生变化，请先重新扫描并审查");
        }
        // 核对原文、起始行与当前文件哈希；保留原始引用，不进行翻译或改写。
        for (const source of request.sources) {
          if (!request.related_paths.includes(source.path)) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "请在 related_paths 中包含每个证据文件");
          const entry = entries.get(source.path), content = await safeSource(this.files, source.path, config);
          if (!entry || entry.sha256 !== source.sha256 || digest(content) !== source.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "证据必须与当前索引中的源码哈希一致");
          const lines = content.split("\n"), snippet = lines.slice(source.line - 1, source.line - 1 + source.quote.split("\n").length).join("\n");
          if (!snippet.includes(source.quote)) throw new AppError("PROJECT_MODEL_EVIDENCE_INVALID", "引用原文必须出现在所提供的源码行号处");
        }
        // 预期修订号在同一锁内核对；调用方须合并最新内容后重试，不能覆盖其他修订。
        const index = await modelIndex(this.files), prior = index.find((entry) => entry.id === request.id);
        if ((prior?.revision ?? 0) !== request.expected_revision) throw new AppError("PROJECT_MODEL_REVISION_CONFLICT", "更新前，请读取模型的最新版本并保留现有发现");
        if (!prior && index.length >= 200) throw new AppError("PROJECT_MODEL_LIMIT", "当前工作区已有 200 个模型");
        const { expected_revision, ...body } = request;
        const model = SavedModelSchema.parse({ ...body, schema_version: 1, project: this.binding.root, revision: expected_revision + 1, recorded_at: new Date().toISOString(),
          related_versions: request.related_paths.map((path) => ({ path, sha256: entries.get(path)!.sha256 })) });
        const raw = JSON.stringify(model) + "\n", hash = digest(raw), path = `${MAP_DIR}/models/${hash}.json`;
        // 先写入以内容哈希命名的不可变版本，再更新当前索引；旧版本留作追溯。
        if (await optional(this.files, path) === undefined) await this.files.create(path, raw);
        const pointer = { id: model.id, revision: model.revision, hash };
        await save(this.files, `${MAP_DIR}/models.json`, [...index.filter((item) => item.id !== model.id), pointer]);
        await renderProjectReport(this.files);
        return { outcome: "ok", code: "PROJECT_MODEL_RECORDED", data: { id: model.id, revision: model.revision, status: "candidate", effective: false,
          report: `${MAP_DIR}/report.html`, next_step: "请使用 project_context 重新核对来源是否最新。引用只能证明来源，不能证明业务正确性，也不代表团队已批准。" }, diagnostics: [] };
      });
    });
  }
}
