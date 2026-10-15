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

export class UnderstandingService {
  private readonly files: ProjectFiles;
  constructor(private readonly binding: WorktreeBinding) { this.files = new ProjectFiles(binding.root); }
  private async execute(action: () => Promise<ToolResult>): Promise<ToolResult> {
    try { return await action(); } catch (error) {
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "PROJECT_UNDERSTANDING_INPUT" : "PROJECT_UNDERSTANDING_FAILED";
      return { outcome: "error", code, diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] };
    }
  }
  async scan(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      ScanInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const map = await scanProject(this.binding); await renderProjectReport(this.files);
        return { outcome: map.coverage.complete ? "ok" : "incomplete", code: "PROJECT_SCANNED", data: await understandingStatus(this.files), diagnostics: map.diagnostics };
      });
    });
  }
  async context(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const data = await projectContext(this.files, input);
      return { outcome: data.state === "needs_rescan" || data.state === "partial" ? "incomplete" : "ok", code: "PROJECT_CONTEXT", data, diagnostics: [] };
    });
  }
  async record(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = ModelRecordInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const map = await readMap(this.files), { config } = await loadConfig(this.files);
        if (!map || map.scan_id !== request.scan_id || map.repo_identity !== this.binding.repo_identity || map.config_hash !== await mapConfigHash(this.files, config)) throw new AppError("PROJECT_MAP_CHANGED", "记录模型前，请先读取最新的项目结构索引");
        if (map.head !== gitLine((await readGit(this.files.root, ["rev-parse", "HEAD"])).stdout)) throw new AppError("PROJECT_MAP_CHANGED", "HEAD 已变化，请刷新项目结构索引");
        const entries = new Map((await mapFiles(this.files)).map((entry) => [entry.path, entry]));
        for (const path of request.related_paths) {
          const entry = entries.get(path);
          if (!entry || digest(await safeSource(this.files, path, config)) !== entry.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "相关文件已缺失或发生变化，请先重新扫描并审查");
        }
        for (const source of request.sources) {
          if (!request.related_paths.includes(source.path)) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "请在 related_paths 中包含每个证据文件");
          const entry = entries.get(source.path), content = await safeSource(this.files, source.path, config);
          if (!entry || entry.sha256 !== source.sha256 || digest(content) !== source.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "证据必须与当前索引中的源码哈希一致");
          const lines = content.split("\n"), snippet = lines.slice(source.line - 1, source.line - 1 + source.quote.split("\n").length).join("\n");
          if (!snippet.includes(source.quote)) throw new AppError("PROJECT_MODEL_EVIDENCE_INVALID", "引用原文必须出现在所提供的源码行号处");
        }
        const index = await modelIndex(this.files), prior = index.find((entry) => entry.id === request.id);
        if ((prior?.revision ?? 0) !== request.expected_revision) throw new AppError("PROJECT_MODEL_REVISION_CONFLICT", "更新前，请读取模型的最新版本并保留现有发现");
        if (!prior && index.length >= 200) throw new AppError("PROJECT_MODEL_LIMIT", "当前工作区已有 200 个模型");
        const { expected_revision, ...body } = request;
        const model = SavedModelSchema.parse({ ...body, schema_version: 1, project: this.binding.root, revision: expected_revision + 1, recorded_at: new Date().toISOString(),
          related_versions: request.related_paths.map((path) => ({ path, sha256: entries.get(path)!.sha256 })) });
        const raw = JSON.stringify(model) + "\n", hash = digest(raw), path = `${MAP_DIR}/models/${hash}.json`;
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
