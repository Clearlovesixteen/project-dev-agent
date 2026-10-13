import { RelativePathSchema } from "../domain/common.js";
import { AppError } from "../domain/error.js";
import type { WorktreeBinding } from "./baseline.js";
import { assertObjectId, decodeGitOutput, readGit } from "./command.js";

function nulFields(output: Buffer): string[] {
  if (output.length === 0) return [];
  const text = decodeGitOutput(output);
  if (!text.endsWith("\0")) throw new AppError("GIT_OUTPUT_INVALID", "Expected NUL-terminated Git path output");
  return text.slice(0, -1).split("\0");
}

function addPath(paths: Set<string>, candidate: string | undefined): void {
  if (candidate === undefined || !RelativePathSchema.safeParse(candidate).success) {
    throw new AppError("INVALID_REPOSITORY_PATH", "Git returned an unsupported or unsafe repository-relative path");
  }
  paths.add(candidate);
}

/** Effective changes from the starting commit to the current worktree, plus untracked files. */
export async function changedPaths(binding: WorktreeBinding, baselineHead: string): Promise<string[]> {
  assertObjectId(baselineHead);
  const unmerged = await readGit(binding.root, ["ls-files", "--unmerged", "-z"]);
  if (unmerged.stdout.length !== 0) {
    throw new AppError("UNMERGED_CHANGES", "Resolve Git merge conflicts before completing the task review");
  }
  const diff = await readGit(binding.root, [
    "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames",
    baselineHead, "--",
  ]);
  const fields = nulFields(diff.stdout);
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status === undefined || !/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(status)) {
      throw new AppError("GIT_OUTPUT_INVALID", "Git returned an invalid name-status record");
    }
    addPath(paths, fields[index++]);
    if (status.startsWith("R") || status.startsWith("C")) addPath(paths, fields[index++]);
  }
  const untracked = await readGit(binding.root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const path of nulFields(untracked.stdout)) addPath(paths, path);
  return [...paths].sort();
}
