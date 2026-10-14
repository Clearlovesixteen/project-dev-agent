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
        if (!map || map.scan_id !== request.scan_id || map.repo_identity !== this.binding.repo_identity || map.config_hash !== await mapConfigHash(this.files, config)) throw new AppError("PROJECT_MAP_CHANGED", "Read the current project map before recording a model");
        if (map.head !== gitLine((await readGit(this.files.root, ["rev-parse", "HEAD"])).stdout)) throw new AppError("PROJECT_MAP_CHANGED", "HEAD changed; refresh the project map");
        const entries = new Map((await mapFiles(this.files)).map((entry) => [entry.path, entry]));
        for (const path of request.related_paths) {
          const entry = entries.get(path);
          if (!entry || digest(await safeSource(this.files, path, config)) !== entry.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "A related file is absent or changed; scan and review it first");
        }
        for (const source of request.sources) {
          if (!request.related_paths.includes(source.path)) throw new AppError("PROJECT_MODEL_SOURCE_SCOPE", "Include each evidence file in related_paths");
          const entry = entries.get(source.path), content = await safeSource(this.files, source.path, config);
          if (!entry || entry.sha256 !== source.sha256 || digest(content) !== source.sha256) throw new AppError("PROJECT_SOURCE_CHANGED", "Evidence must match the current indexed source hash");
          const lines = content.split("\n"), snippet = lines.slice(source.line - 1, source.line - 1 + source.quote.split("\n").length).join("\n");
          if (!snippet.includes(source.quote)) throw new AppError("PROJECT_MODEL_EVIDENCE_INVALID", "Quote must occur at the supplied source line");
        }
        const index = await modelIndex(this.files), prior = index.find((entry) => entry.id === request.id);
        if ((prior?.revision ?? 0) !== request.expected_revision) throw new AppError("PROJECT_MODEL_REVISION_CONFLICT", "Read the latest model revision and preserve existing findings before updating");
        if (!prior && index.length >= 200) throw new AppError("PROJECT_MODEL_LIMIT", "This worktree already contains 200 models");
        const { expected_revision, ...body } = request;
        const model = SavedModelSchema.parse({ ...body, schema_version: 1, project: this.binding.root, revision: expected_revision + 1, recorded_at: new Date().toISOString(),
          related_versions: request.related_paths.map((path) => ({ path, sha256: entries.get(path)!.sha256 })) });
        const raw = JSON.stringify(model) + "\n", hash = digest(raw), path = `${MAP_DIR}/models/${hash}.json`;
        if (await optional(this.files, path) === undefined) await this.files.create(path, raw);
        const pointer = { id: model.id, revision: model.revision, hash };
        await save(this.files, `${MAP_DIR}/models.json`, [...index.filter((item) => item.id !== model.id), pointer]);
        await renderProjectReport(this.files);
        return { outcome: "ok", code: "PROJECT_MODEL_RECORDED", data: { id: model.id, revision: model.revision, status: "candidate", effective: false,
          report: `${MAP_DIR}/report.html`, next_step: "Recheck source freshness with project_context. Quotes prove provenance, not correctness or team approval." }, diagnostics: [] };
      });
    });
  }
}
