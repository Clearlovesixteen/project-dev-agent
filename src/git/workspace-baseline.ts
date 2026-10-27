import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { AppError } from "../domain/error.js";
import {
  WorkspaceBaselineSchema,
  type WorkspaceBaseline,
} from "../domain/workspace-baseline.js";
import { digest } from "../knowledge/document.js";
import type { WorktreeBinding } from "./baseline.js";
import { reviewSnapshot } from "./review-snapshot.js";
import { workspaceContent } from "./workspace-content.js";
import { readGit } from "./command.js";
const blobPath = (hash: string) =>
  `.project-dev/local/baselines/blobs/${hash}.json`;

/** 初始改动内容按哈希分块保存；不 stash、提交、改 index 或重写业务文件。 */
export async function captureWorkspaceBaseline(
  binding: WorktreeBinding,
): Promise<WorkspaceBaseline> {
  const before = await reviewSnapshot(binding, binding.head),
    files = new ProjectFiles(binding.root),
    entries = [];
  let total = 0;
  if (before.paths.length > 2000)
    throw new AppError(
      "WORKSPACE_BASELINE_LIMIT",
      "接入前改动超过2000个文件，无法完整建立基线",
    );
  for (const path of before.paths) {
    const { entry, content, bytes } = await workspaceContent(files, path, true);
    total += bytes;
    if (total > 64 * 1024 * 1024)
      throw new AppError(
        "WORKSPACE_BASELINE_LIMIT",
        "接入前内容超过64 MiB，未建立不完整基线",
      );
    if (content) {
      const chunks = [];
      for (let offset = 0; offset < content.length; offset += 524288) {
        const data = content.subarray(offset, offset + 524288),
          hash = digest(data.toString("base64"));
        chunks.push(hash);
        const raw = JSON.stringify({ base64: data.toString("base64") });
        try {
          await files.create(blobPath(hash), raw, 1048576);
        } catch (error) {
          if (
            !hasCode(error, "FILE_EXISTS") ||
            (await files.read(blobPath(hash), 1048576)) !== raw
          )
            throw error;
        }
      }
      entries.push({ ...entry, chunks });
    } else entries.push(entry);
  }
  if ((await reviewSnapshot(binding, binding.head)).hash !== before.hash)
    throw new AppError(
      "REVIEW_SNAPSHOT_CHANGED",
      "建立接入基线时内容变化，请重新接入",
    );
  return WorkspaceBaselineSchema.parse({
    version: 1,
    snapshot: before.hash,
    entries,
  });
}
/** 读取保存的接入内容供原文依据和复用比较使用；没有覆盖项时才读取固定 Git 提交。 */
export async function baselineContent(
  binding: WorktreeBinding,
  head: string,
  path: string,
  initial?: WorkspaceBaseline,
): Promise<string> {
  const entry = initial?.entries.find((item) => item.path === path);
  if (entry) {
    if (entry.kind !== "file") return "";
    const files = new ProjectFiles(binding.root),
      chunks = [];
    for (const hash of entry.chunks ?? []) {
      const value = JSON.parse(await files.read(blobPath(hash), 1048576));
      if (typeof value.base64 !== "string" || digest(value.base64) !== hash)
        throw new AppError(
          "WORKSPACE_BASELINE_CORRUPT",
          "接入内容分块哈希不一致",
        );
      chunks.push(Buffer.from(value.base64, "base64"));
    }
    const bytes = Buffer.concat(chunks);
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new AppError("WORKSPACE_BASELINE_CORRUPT", "接入内容哈希不一致");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const meta = (
    await readGit(binding.root, ["ls-tree", head, "--", `:(literal)${path}`])
  ).stdout.toString("utf8");
  if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(meta)) return "";
  const result = await readGit(binding.root, ["show", `${head}:${path}`]);
  if (result.stdout.length > 8 * 1024 * 1024)
    throw new AppError("FILE_LIMIT", "基线内容超出8 MiB");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}
