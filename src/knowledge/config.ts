import { z } from "zod";
import { RelativePathSchema, TextSchema } from "../domain/common.js";
import { AppError } from "../domain/error.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { parseYaml } from "./document.js";

export const ProjectConfigSchema = z.object({
  schema_version: z.literal(1),
  knowledge_dir: RelativePathSchema.default(".project-dev/knowledge").refine((path) =>
    !path.split("/").some((part) => [".git", "node_modules", "local"].includes(part)) && !/[\*?\[\]]/.test(path),
    "Use a concrete shared knowledge directory outside Git internals, node_modules and local state"),
  modules: z.array(z.object({ name: TextSchema, paths: z.array(RelativePathSchema).min(1).max(50) }).strict()).max(100).default([]),
  exclude_paths: z.array(RelativePathSchema).max(100).default(["node_modules", "dist", ".project-dev/local"]),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.modules.map((entry) => entry.name)).size !== config.modules.length) {
    ctx.addIssue({ code: "custom", path: ["modules"], message: "Module names must be unique" });
  }
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export const DEFAULT_CONFIG = ProjectConfigSchema.parse({ schema_version: 1 });

export async function loadConfig(files: ProjectFiles): Promise<{ config: ProjectConfig; defaulted: boolean }> {
  let text: string;
  try { text = await files.read(".project-dev/project.yaml"); } catch (error) {
    if (hasCode(error, "ENOENT")) return { config: structuredClone(DEFAULT_CONFIG), defaulted: true };
    throw error;
  }
  try { return { config: ProjectConfigSchema.parse(parseYaml(text)), defaulted: false }; } catch (error) {
    throw new AppError("INVALID_PROJECT_CONFIG", error instanceof Error ? error.message : String(error));
  }
}

/** Literal path prefixes, plus *, ** and ? globs. No code execution or glob expansion on disk. */
export function matchesPath(pattern: string, path: string): boolean {
  if (!/[\*?]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`);
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index++; }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(path);
}
