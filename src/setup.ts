import { SKILL_FILES } from "./skill-files.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { bindWorktree, assertStateIgnored } from "./git/index.js";
import { AppError } from "./domain/error.js";
import { hasCode, ProjectFiles } from "./storage/project-files.js";
import { DEFAULT_CONFIG, loadConfig } from "./knowledge/config.js";
import { findToolRoot, findCliPath } from "./package-root.js";

import { VERSION } from "./version.js";

const MARKER = "<!-- project-dev-agent -->";
const GUIDANCE = `${MARKER}\n跟踪项目改动时，结合 project-dev Skill 和 project_dev MCP 服务工作。选择实现方案前阅读适用知识和现有代码，记录关联路径与审查证据。任务状态和经验草稿保存在 .project-dev/local/。通过团队审查流程确认共享规则。新生成的说明默认使用中文，代码与原话引用保持原样。\n<!-- /project-dev-agent -->\n`;
// 项目级 Skill 和本地插件均需携带全部可发现的生码参考资料。

interface Change { file: string; action: "create" | "append" | "unchanged" | "preserve"; before?: string; after: string }

export async function initializeProject(project: string, apply: boolean) {
  const binding = await bindWorktree(project);
  const toolRoot = await findToolRoot();
  if (binding.root === toolRoot) throw new AppError("TOOL_PROJECT_CONFLICT", "请选择业务目标项目进行初始化，不能初始化工具包自身");
  const files = new ProjectFiles(binding.root);
  const { config } = await loadConfig(files);
  const changes: Change[] = [];
  const warnings: string[] = [];
  async function plan(file: string, content: string, append?: (current: string) => string) {
    await files.path(file, true);
    let before: string | undefined;
    try { before = await files.read(file, 65_536); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    const after = before !== undefined && append ? append(before) : content;
    const action = before === undefined ? "create" : before === after ? "unchanged" : append ? "append" : "preserve";
    if (action === "preserve") warnings.push(`已保留自定义文件 ${file}；更新前请与软件包中的版本对比。`);
    changes.push({ file, action, ...(before !== undefined ? { before } : {}), after: action === "preserve" ? before! : after });
  }
  await plan(".gitignore", "/.project-dev/local/\n", (current) => /^(?:\/)?\.project-dev\/local\/$/m.test(current)
    ? current : `${current}${current.endsWith("\n") ? "" : "\n"}/.project-dev/local/\n`);
  await plan(".project-dev/project.yaml", stringify(DEFAULT_CONFIG, { lineWidth: 0 }));
  await plan("AGENTS.md", GUIDANCE, (current) => current.includes(MARKER) ? current : `${current}\n${GUIDANCE}`);
  const knowledgeDirectory = config.knowledge_dir.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  await plan(".project-dev/README.html", (await readFile(join(toolRoot, "templates/project-readme.html"), "utf8"))
    .replaceAll("{{knowledge_directory}}", knowledgeDirectory));
  for (const name of SKILL_FILES) await plan(`.agents/skills/project-dev/${name}`, await readFile(join(toolRoot, "skills/project-dev", name), "utf8"));
  const cli = await findCliPath(toolRoot);
  const args = [cli, "serve", "--project", binding.root];
  const toml = `[mcp_servers.project_dev]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\n`;
  await plan(".project-dev/local/codex.toml", toml);
  // Per-project generated plugin: concrete absolute paths avoid guessing host-specific variable expansion.
  await plan(".project-dev/local/plugin/plugin.json", `${JSON.stringify({
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "project-dev-agent", version: VERSION,
    description: "为 Codex 提供项目规则、关联改动清单和可核对的开发经验",
  }, null, 2)}\n`);
  await plan(".project-dev/local/plugin/mcp.json", `${JSON.stringify({
    "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { project_dev: { type: "stdio", command: process.execPath, args } },
  }, null, 2)}\n`);
  for (const name of SKILL_FILES) await plan(`.project-dev/local/plugin/skills/project-dev/${name}`, await readFile(join(toolRoot, "skills/project-dev", name), "utf8"));
  await files.path(config.knowledge_dir, true);
  if (apply) {
    for (const change of changes) {
      if (change.action === "create") await files.create(change.file, change.after);
      if (change.action === "append") await files.replace(change.file, change.after, change.before!);
      if (change.file === ".gitignore") await assertStateIgnored(binding);
    }
    await files.directory(config.knowledge_dir);
  }
  return { outcome: "ok", applied: apply, project: binding.root,
    changes: changes.map(({ file, action, before, after }) => ({ file, action, ...(apply ? {} : { before, after }) })), warnings,
    codex_config: ".project-dev/local/codex.toml", generated_plugin: ".project-dev/local/plugin",
    next_step: "按团队原有 Git 流程审查并提交项目接入改动。在 Codex 配置生成的 MCP 连接后新建对话；仍需在目标客户端验证插件实际加载情况。" };
}
