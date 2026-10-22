import { execFile } from "node:child_process";
import { readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "./domain/error.js";
import { findToolRoot, findCliPath } from "./package-root.js";
import { hasCode, ProjectFiles } from "./storage/project-files.js";
import { Workspace } from "./workspace.js";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = ".agents/skills/project-dev";
// 显式列出运行 Skill 所需的参考资料，确保手动安装与原生插件的规则一致。
const SKILL_FILES = ["SKILL.md", "references/task-inputs.md", "references/history-inputs.md", "references/understanding-inputs.md", "references/generation-rules.md"];
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
  const args = [await findCliPath(toolRoot), "serve", "--workspace", workspace.root];
  const run: CodexRunner = options.runCodex ?? (async (arguments_) => {
    try {
      return (await execFileAsync(options.codex, arguments_, { cwd: home, encoding: "utf8", maxBuffer: 2_000_000, timeout: 20_000 })).stdout;
    } catch {
      throw new AppError("CODEX_COMMAND_FAILED", "Codex 配置命令执行失败，请检查 --codex 指定的可执行文件路径和文件系统权限；输出不包含凭据。");
    }
  });
  const listed: unknown = JSON.parse(await run(["mcp", "list", "--json"]));
  if (!Array.isArray(listed)) throw new AppError("CODEX_CONFIG_INVALID", "Codex 未返回有效的 MCP 服务列表");
  const existing = listed.find((entry: { name?: string }) => entry.name === "project_dev");
  if (existing && (existing.transport?.type !== "stdio" || existing.transport.command !== process.execPath
    || JSON.stringify(existing.transport.args) !== JSON.stringify(args) || existing.enabled === false)) {
    throw new AppError("MCP_CONFIG_CONFLICT", "已有 project_dev 服务的配置不同。请保留原配置，明确解决冲突后再连接。");
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
      if (!options.disconnect) for (const version of ["v0.2.1", "v0.3.0", "v0.4.0", "v0.5.0", "v0.6.0", "v0.6.2", "v0.6.3", "v0.6.4", "v0.6.5"]) {
        try { predecessors.push(await readFile(join(toolRoot, "templates/previous-skills", version, name), "utf8")); }
        catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      }
      if (!predecessors.includes(before)) throw new AppError("SKILL_CONFLICT", `已保留不同或经过自定义的 Skill：${join(home, file)}`);
      upgrade = true;
    }
    plans.push({ file, content, ...(before !== undefined ? { before } : {}), exists: before !== undefined, upgrade });
  }
  if (options.apply) {
    if (options.disconnect) {
      if (existing) await run(["mcp", "remove", "project_dev"]);
      for (const plan of plans) {
        if (!plan.exists) continue;
        if (await files.read(plan.file, 65_536) !== plan.content) throw new AppError("FILE_CHANGED", "断开连接时 Skill 内容发生变化，已保留该文件");
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
    next_step: options.disconnect ? "项目记录和已安装的软件包已保留。请在 Codex 中重新加载 MCP 连接。"
      : "在工作范围内的仓库新建 Codex 对话，用 $project-dev 描述开发需求；若工具未出现，请在设置的 MCP 服务中重启 project_dev 连接。",
  };
}
