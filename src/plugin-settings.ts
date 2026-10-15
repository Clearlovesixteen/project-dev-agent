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
import { prepareProject, ProjectPrepareInputSchema } from "./personal-setup.js";

const FILE = "project-dev-agent/settings.json";
const LOCK = "project-dev-agent/settings.lock";
const Settings = z.object({
  schema_version: z.literal(1), revision: z.uuid(),
  workspace: z.string().min(1).max(4096), requested_workspace: z.string().min(1).max(4096),
}).strict();

export const PluginConfigureInput = z.object({
  workspace: z.string().min(1).max(4096).describe("用户明确选择的绝对目录，其中包含允许使用的 Git 项目"),
  apply: z.boolean().default(false),
  expected_revision: z.uuid().nullable().optional().describe("应用设置时传入状态或预览的修订号；null 表示尚无配置"),
}).strict();

/** User configuration is independent of the replaceable plugin installation/cache. */
export class PluginSettings {
  constructor(private readonly codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {}

  private async files(): Promise<ProjectFiles> {
    if (!isAbsolute(this.codexHome)) throw new AppError("PLUGIN_HOME_INVALID", "CODEX_HOME 必须是已存在目录的绝对路径");
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
      throw new AppError("PLUGIN_SETTINGS_INVALID", "插件配置无效，请检查文件后再修改");
    }
    return { raw, value: parsed.data };
  }

  async status(): Promise<ToolResult> {
    const files = await this.files();
    const current = await this.read(files);
    return { outcome: "ok", code: "PLUGIN_STATUS", diagnostics: [], data: {
      version: VERSION, configured: current !== null, workspace: current?.value.workspace ?? null,
      revision: current?.value.revision ?? null, settings_path: join(files.root, FILE),
      next_step: current ? "调用 project_prepare，并将当前 Git 绝对根目录作为 project"
        : "用当前 Git 绝对根目录调用 project_prepare 并传 apply: true，即可自动初始化；仅调整工作范围时才需使用 project-dev-setup",
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
        changes: ["将该目录保存为项目工具的工作范围，并保留全部项目记录"],
      } };
    }
    if (input.expected_revision === undefined) throw new AppError("PLUGIN_REVISION_REQUIRED", "请先预览，再传入 expected_revision；首次设置传 null");
    await files.directory("project-dev-agent");
    try { await files.create(LOCK, JSON.stringify({ pid: process.pid })); } catch (error) {
      if (error instanceof AppError && error.code === "FILE_EXISTS") throw new AppError("PLUGIN_SETTINGS_BUSY", "其他进程正在修改设置，请完成后重试。疑似遗留的 settings.lock 需检查后再处理");
      throw error;
    }
    try {
      const current = await this.read(files);
      if ((current?.value.revision ?? null) !== input.expected_revision) {
        throw new AppError("PLUGIN_SETTINGS_CHANGED", "预览后配置发生变化，请核对新的工作范围后再重试");
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

  async prepare(project: string | undefined, raw: unknown): Promise<ToolResult> {
    const input = ProjectPrepareInputSchema.parse(raw);
    const files = await this.files();
    if (await this.read(files)) return prepareProject(await this.bind(project), input);

    if (!project || !isAbsolute(project)) throw new AppError("PROJECT_REQUIRED", "初始化时请传入当前 Git 工作树的绝对根目录");
    // First use authorizes only this repository, never its parent or the plugin's process cwd.
    const workspace = await Workspace.open(project);
    const binding = await workspace.bind(project);
    const preview = await prepareProject(binding, { apply: false });
    if (!input.apply) return { ...preview, data: {
      ...preview.data as Record<string, unknown>,
      plugin_setup: { action: "would_initialize", workspace: workspace.root, settings_path: join(files.root, FILE) },
      next_step: "调用 project_prepare 并传 apply: true，初始化当前仓库并忽略本地记录后继续开发",
    } };

    // Compare against absence under the existing settings lock; a concurrent selection must win.
    await this.configure({ workspace: project, apply: true, expected_revision: null });
    const prepared = await prepareProject(await this.bind(project), input);
    return { ...prepared, data: {
      ...prepared.data as Record<string, unknown>,
      plugin_setup: { action: "initialized", workspace: workspace.root, settings_path: join(files.root, FILE) },
    } };
  }

  async bind(project?: string) {
    const settings = (await this.read(await this.files()))?.value;
    if (!settings) throw new AppError("PLUGIN_NOT_CONFIGURED", "用当前 Git 绝对根目录调用 project_prepare，并传 apply: true 自动初始化");
    const workspace = await Workspace.open(settings.requested_workspace);
    if (workspace.root !== settings.workspace) throw new AppError("WORKSPACE_CHANGED", "已配置工作目录的标识发生变化，请核对后再重新设置");
    return workspace.bind(project);
  }
}
