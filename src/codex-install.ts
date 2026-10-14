import { execFile } from "node:child_process";
import { readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "./domain/error.js";
import { findToolRoot } from "./package-root.js";
import { hasCode, ProjectFiles } from "./storage/project-files.js";
import { Workspace } from "./workspace.js";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = ".agents/skills/project-dev";
const SKILL_FILES = ["SKILL.md", "references/task-inputs.md", "references/history-inputs.md", "references/understanding-inputs.md"];
type CodexRunner = (args: string[]) => Promise<string>;
interface Options {
  workspace: string;
  codex: string;
  apply: boolean;
  disconnect?: boolean;
  // Dependency injection keeps installer tests away from the user's real configuration.
  userHome?: string;
  runCodex?: CodexRunner;
}

export async function connectCodex(options: Options) {
  const workspace = await Workspace.open(options.workspace);
  const home = await realpath(options.userHome ?? homedir());
  const files = new ProjectFiles(home);
  const toolRoot = await findToolRoot();
  const args = [join(toolRoot, "dist/src/cli.js"), "serve", "--workspace", workspace.root];
  const run: CodexRunner = options.runCodex ?? (async (arguments_) => {
    try {
      return (await execFileAsync(options.codex, arguments_, { cwd: home, encoding: "utf8", maxBuffer: 2_000_000, timeout: 20_000 })).stdout;
    } catch {
      throw new AppError("CODEX_COMMAND_FAILED", "Codex configuration command failed. Check the --codex executable path and filesystem permissions; no credentials are printed.");
    }
  });
  const listed: unknown = JSON.parse(await run(["mcp", "list", "--json"]));
  if (!Array.isArray(listed)) throw new AppError("CODEX_CONFIG_INVALID", "Codex did not return an MCP server list");
  const existing = listed.find((entry: { name?: string }) => entry.name === "project_dev");
  if (existing && (existing.transport?.type !== "stdio" || existing.transport.command !== process.execPath
    || JSON.stringify(existing.transport.args) !== JSON.stringify(args) || existing.enabled === false)) {
    throw new AppError("MCP_CONFIG_CONFLICT", "An existing project_dev server has different settings. Preserve it and resolve the configuration explicitly before connecting.");
  }
  const plans: { file: string; content: string; before?: string; exists: boolean; upgrade: boolean }[] = [];
  for (const name of SKILL_FILES) {
    const file = `${SKILL_ROOT}/${name}`;
    await files.path(file, true);
    const content = await readFile(join(toolRoot, "skills/project-dev", name), "utf8");
    let before: string | undefined;
    try { before = await files.read(file, 65_536); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    let upgrade = false;
    if (before !== undefined && before !== content) {
      // Upgrade only an exact bundled predecessor. Never replace local customizations.
      const predecessors: string[] = [];
      if (!options.disconnect) for (const version of ["v0.2.1", "v0.3.0"]) {
        try { predecessors.push(await readFile(join(toolRoot, "templates/previous-skills", version, name), "utf8")); }
        catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      }
      if (!predecessors.includes(before)) throw new AppError("SKILL_CONFLICT", `Preserving a different or customized skill: ${join(home, file)}`);
      upgrade = true;
    }
    plans.push({ file, content, ...(before !== undefined ? { before } : {}), exists: before !== undefined, upgrade });
  }
  if (options.apply) {
    if (options.disconnect) {
      if (existing) await run(["mcp", "remove", "project_dev"]);
      for (const plan of plans) {
        if (!plan.exists) continue;
        if (await files.read(plan.file, 65_536) !== plan.content) throw new AppError("FILE_CHANGED", "Skill changed while disconnecting; preserved it");
        await unlink(await files.path(plan.file));
      }
      for (const directory of [`${SKILL_ROOT}/references`, SKILL_ROOT]) {
        try { await rmdir(await files.path(directory)); } catch (error) {
          if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) throw error;
        }
      }
    } else {
      const created: string[] = [];
      const upgraded: typeof plans = [];
      try {
        for (const plan of plans) {
          if (!plan.exists) { await files.create(plan.file, plan.content); created.push(plan.file); }
          else if (plan.upgrade) { await files.replace(plan.file, plan.content, plan.before!); upgraded.push(plan); }
        }
        if (!existing) await run(["mcp", "add", "project_dev", "--", process.execPath, ...args]);
      } catch (error) {
        // Only roll back newly created, still-identical files, never a pre-existing skill.
        for (const file of created) {
          const expected = plans.find((plan) => plan.file === file)!.content;
          if (await files.read(file, 65_536) === expected) await unlink(await files.path(file));
        }
        for (const plan of upgraded) {
          if (await files.read(plan.file, 65_536) === plan.content) await files.replace(plan.file, plan.before!, plan.content);
        }
        throw error;
      }
    }
  }
  return { outcome: "ok", applied: options.apply, operation: options.disconnect ? "disconnect" : "connect",
    workspace: workspace.root, skill: join(home, SKILL_ROOT),
    mcp: { name: "project_dev", command: process.execPath, args, action: options.disconnect ? existing ? "remove" : "unchanged" : existing ? "unchanged" : "add" },
    skill_files: plans.map(({ file, exists, upgrade }) => ({ file: join(home, file), action: options.disconnect ? exists ? "remove" : "unchanged" : upgrade ? "update" : exists ? "unchanged" : "create" })),
    next_step: options.disconnect ? "Project records and installed package are preserved. Reload MCP connections in Codex."
      : "Start a new Codex chat in a repository inside this workspace. Invoke $project-dev with your development request; if tools are absent, restart the project_dev connection in Settings > MCP servers.",
  };
}
