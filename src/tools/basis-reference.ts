import { z } from "zod";
import { AppError } from "../domain/error.js";
import { referenceError, type ReferenceIssue } from "../quality/reference-repair.js";
import type { WorktreeBinding } from "../git/index.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { WireBasis } from "../quality/basis-contracts.js";
import { ProjectFiles } from "../storage/project-files.js";
import { safeSource } from "../understanding/scan.js";

/** 只补充可由当前仓库确证的字段。旧完整引用保留给领域服务，它还能核对历史任务基线。 */
export async function completeBasis(binding: WorktreeBinding, basis?: z.infer<typeof WireBasis>) {
  if (!basis || basis.references.every(ref => ref.line !== undefined && ref.sha256 !== undefined)) return basis;
  const files = new ProjectFiles(binding.root), { config } = await loadConfig(files);
  const sources = new Map<string, string>();
  const references = [];
  const issues: ReferenceIssue[] = [], verified: string[] = [];
  let firstCode: string | undefined;
  for (const [index, ref] of basis.references.entries()) {
    if (ref.line !== undefined && ref.sha256 !== undefined) { references.push(ref); continue; }
    let text = sources.get(ref.path);
    if (text === undefined) {
      try { text = await safeSource(files, ref.path, config); }
      catch (error) {
        if (!issues.length) firstCode = error instanceof AppError ? error.code : "PROJECT_OPERATION_FAILED";
        issues.push({ index, id: ref.id, fields: ["path"], reason: "source_unavailable" });
        continue;
      }
      sources.set(ref.path, text);
    }
    const sha256 = digest(text);
    const lines = text.split(/\r?\n/);
    let line = ref.line;
    if (line === undefined) {
      const first = lines.findIndex(value => value.includes(ref.quote));
      if (first < 0) {
        issues.push({ index, id: ref.id, fields: ["quote"], reason: "quote_not_found" });
        continue;
      }
      if (lines.findIndex((value, index) => index > first && value.includes(ref.quote)) >= 0) {
        issues.push({ index, id: ref.id, fields: ["line"], reason: "ambiguous_quote" });
        continue;
      }
      line = first + 1;
    }
    const fields: string[] = [];
    if (ref.sha256 !== undefined && ref.sha256 !== sha256) fields.push("sha256");
    if (!lines[line - 1]?.includes(ref.quote)) fields.push("line", "quote");
    if (fields.length) {
      issues.push({ index, id: ref.id, fields, reason: "source_changed" });
      continue;
    }
    references.push({ ...ref, sha256, line });
    verified.push(ref.id);
  }
  // 完整格式的引用仍留给领域层核对任务基线，不能在这里冒充已经验证或部分保存。
  if (issues.length) throw referenceError(issues, verified, firstCode);
  return { ...basis, references };
}
