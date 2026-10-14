import { randomUUID } from "node:crypto";
import { realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import type { ToolResult } from "./domain/result.js";
import { ProjectFiles, hasCode } from "./storage/project-files.js";
import { VERSION } from "./version.js";
import { Workspace } from "./workspace.js";

const FILE = "project-dev-agent/settings.json";
const LOCK = "project-dev-agent/settings.lock";
const Settings = z.object({
  schema_version: z.literal(1), revision: z.uuid(),
  workspace: z.string().min(1).max(4096), requested_workspace: z.string().min(1).max(4096),
}).strict();

export const PluginConfigureInput = z.object({
  workspace: z.string().min(1).max(4096).describe("Absolute directory explicitly selected by the user; contains the allowed Git projects"),
  apply: z.boolean().default(false),
  expected_revision: z.uuid().nullable().optional().describe("For apply, pass the revision from status/preview; null means no existing settings"),
}).strict();

/** User configuration is independent of the replaceable plugin installation/cache. */
export class PluginSettings {
  constructor(private readonly codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {}

  private async files(): Promise<ProjectFiles> {
    if (!isAbsolute(this.codexHome)) throw new AppError("PLUGIN_HOME_INVALID", "CODEX_HOME must be an absolute existing directory");
    return new ProjectFiles(await realpath(this.codexHome));
  }

  private async read(files: ProjectFiles) {
    let raw: string;
    try { raw = await files.read(FILE); } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    const parsed = Settings.safeParse(JSON.parse(raw));
    if (!parsed.success || !isAbsolute(parsed.data.workspace) || !isAbsolute(parsed.data.requested_workspace)) {
      throw new AppError("PLUGIN_SETTINGS_INVALID", "Plugin settings are invalid; inspect the file before changing it");
    }
    return { raw, value: parsed.data };
  }

  async status(): Promise<ToolResult> {
    const files = await this.files();
    const current = await this.read(files);
    return { outcome: "ok", code: "PLUGIN_STATUS", diagnostics: [], data: {
      version: VERSION, configured: current !== null, workspace: current?.value.workspace ?? null,
      revision: current?.value.revision ?? null, settings_path: join(files.root, FILE),
      next_step: current ? "Pass the absolute current Git root as project to project_prepare" : "Use project-dev-setup to choose and configure your workspace",
    } };
  }

  async configure(raw: unknown): Promise<ToolResult> {
    const input = PluginConfigureInput.parse(raw);
    const workspace = await Workspace.open(input.workspace);
    const files = await this.files();
    if (!input.apply) {
      const current = await this.read(files);
      return { outcome: "ok", code: "PLUGIN_CONFIGURE_PREVIEW", diagnostics: [], data: {
        workspace: workspace.root, previous_workspace: current?.value.workspace ?? null,
        expected_revision: current?.value.revision ?? null, settings_path: join(files.root, FILE),
        changes: ["Save this workspace as the scope for project tools; keep all project records"],
      } };
    }
    if (input.expected_revision === undefined) throw new AppError("PLUGIN_REVISION_REQUIRED", "Preview first, then pass expected_revision (null for first setup)");
    await files.directory("project-dev-agent");
    try { await files.create(LOCK, JSON.stringify({ pid: process.pid })); } catch (error) {
      if (error instanceof AppError && error.code === "FILE_EXISTS") throw new AppError("PLUGIN_SETTINGS_BUSY", "Settings are being changed; retry after completion. Inspect a stale settings.lock before removing it");
      throw error;
    }
    try {
      const current = await this.read(files);
      if ((current?.value.revision ?? null) !== input.expected_revision) {
        throw new AppError("PLUGIN_SETTINGS_CHANGED", "Settings changed after preview; inspect the new workspace before retrying");
      }
      if (current?.value.workspace !== workspace.root || current.value.requested_workspace !== resolve(input.workspace)) {
        const next = JSON.stringify({ schema_version: 1, revision: randomUUID(), workspace: workspace.root,
          requested_workspace: resolve(input.workspace) }, null, 2) + "\n";
        if (current) await files.replace(FILE, next, current.raw);
        else await files.create(FILE, next);
      }
      return await this.status();
    } finally { await unlink(await files.path(LOCK)); }
  }

  async bind(project?: string) {
    const settings = (await this.read(await this.files()))?.value;
    if (!settings) throw new AppError("PLUGIN_NOT_CONFIGURED", "Choose your workspace with project-dev-setup before using project tools");
    const workspace = await Workspace.open(settings.requested_workspace);
    if (workspace.root !== settings.workspace) throw new AppError("WORKSPACE_CHANGED", "Configured workspace changed identity; inspect it before reconfiguring");
    return workspace.bind(project);
  }
}
