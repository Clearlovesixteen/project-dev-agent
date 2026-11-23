import { z } from "zod";
import { AppError } from "../domain/error.js";
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
  for (const ref of basis.references) {
    if (ref.line !== undefined && ref.sha256 !== undefined) { references.push(ref); continue; }
    let text = sources.get(ref.path);
    if (text === undefined) {
      text = await safeSource(files, ref.path, config);
      sources.set(ref.path, text);
    }
    const sha256 = digest(text);
    const lines = text.split(/\r?\n/);
    let line = ref.line;
    if (line === undefined) {
      const first = lines.findIndex(value => value.includes(ref.quote));
      if (first < 0 || lines.findIndex((value, index) => index > first && value.includes(ref.quote)) >= 0)
        throw new AppError("IMPLEMENTATION_REFERENCE_INVALID", `引用 ${ref.id} 的原文没有唯一匹配，请核对原文并补充 line。`);
      line = first + 1;
    }
    if ((ref.sha256 !== undefined && ref.sha256 !== sha256) || !lines[line - 1]?.includes(ref.quote))
      throw new AppError("IMPLEMENTATION_REFERENCE_INVALID", `引用 ${ref.id} 的行号或指纹已变化，请核对该行原文。`);
    references.push({ ...ref, sha256, line });
  }
  return { ...basis, references };
}
