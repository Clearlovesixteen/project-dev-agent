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
const GUIDANCE = `${MARKER}\nFor tracked project changes, use the project-dev skill with the project_dev MCP server. Read applicable project knowledge and existing code before choosing an implementation. Record related paths and review evidence. Keep generated task state and draft experience in .project-dev/local/. Confirm shared rules through the team's review process.\n<!-- /project-dev-agent -->\n`;
const SKILL_FILES = ["SKILL.md", "references/task-inputs.md", "references/history-inputs.md", "references/understanding-inputs.md"];

interface Change { file: string; action: "create" | "append" | "unchanged" | "preserve"; before?: string; after: string }

export async function initializeProject(project: string, apply: boolean) {
  const binding = await bindWorktree(project);
  const toolRoot = await findToolRoot();
  if (binding.root === toolRoot) throw new AppError("TOOL_PROJECT_CONFLICT", "Initialize a target project, not the tool package itself");
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
    if (action === "preserve") warnings.push(`Preserved customized file ${file}; compare it with the packaged version before updating.`);
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
    description: "Project rules, related-change checklists, and reviewable development experience for Codex",
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
    next_step: "Review and commit project setup changes through your usual Git process. Configure the generated MCP connection in Codex and start a new chat. Client plugin loading still requires verification in the target client." };
}
