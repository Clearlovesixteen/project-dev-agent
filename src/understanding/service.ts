import { z } from "zod";
import { AppError } from "../domain/error.js";
import type { ToolResult } from "../domain/result.js";
import { assertStateIgnored, type WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { MAP_DIR, ModelRecordInput, ScanInput } from "./contracts.js";
import { locked, understandingStatus } from "./store.js";
import { scanProject } from "./scan.js";
import { projectContext } from "./context.js";
import { renderProjectReport } from "./report.js";
import { recordModel } from "./model-record.js";

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
      return { outcome: ["needs_rescan", "needs_review", "partial"].includes(data.state) ? "incomplete" : "ok", code: "PROJECT_CONTEXT", data, diagnostics: [] };
    });
  }
  /** 保存有源码依据的模型候选；引用匹配只证明来源，不把语义结论自动确认为规则。 */
  async record(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = ModelRecordInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const model = await recordModel(this.files, this.binding, request);
        const current = await projectContext(this.files, { model_id: model.id });
        const view = current.models[0];
        const diagnostics: { code: string; message: string }[] = [];
        try { await renderProjectReport(this.files); }
        catch { diagnostics.push({ code: "PROJECT_REPORT_UNAVAILABLE", message: "模型修订已保存，报告生成失败；可通过 project_context 读取，不要重复写入。" }); }
        return { outcome: "ok", code: "PROJECT_MODEL_RECORDED", data: { id: model.id, revision: model.revision,
          model_audit: "model_audit" in current ? current.model_audit : undefined,
          status: view?.status ?? "needs_review", effective: false, schema_version: model.schema_version,
          ...("review_required" in (view ?? {}) ? { review_required: (view as Record<string, unknown>).review_required } : {}),
          report: `${MAP_DIR}/report.html`, next_step: "模型已保存；未复核条目继续保留旧依据。引用匹配不证明业务判断正确，也不代表用户或团队批准。" }, diagnostics };

      });
    });
  }
}
