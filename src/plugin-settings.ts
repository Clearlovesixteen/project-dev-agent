import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import type { ToolResult } from "./domain/result.js";
import { ProjectFiles, hasCode } from "./storage/project-files.js";
import { VERSION } from "./version.js";
import { Workspace } from "./workspace.js";
import { prepareProject, ProjectPrepareInputSchema } from "./personal-setup.js";
import { acquireFileLock } from "./storage/file-lock.js";
import { AbsoluteProjectPath as AbsolutePath, EnrolledProject as ProjectEntry, bindEnrolledProject as bindEntry, inspectEnrolledProject } from "./project-enrollment.js";
import type { DiagnosticContext } from "./observability/diagnostic-context.js";

const FILE = "project-dev-agent/settings.json";
const LOCK = "project-dev-agent/settings.lock";
const LegacySettings = z.object({
  schema_version: z.literal(1), revision: z.uuid(),
  workspace: AbsolutePath, requested_workspace: AbsolutePath,
}).strict();
const WorkspaceSettings = LegacySettings.extend({ schema_version: z.literal(2), mode: z.literal("workspace") });
const ProjectsSettings = z.object({
  schema_version: z.literal(2), revision: z.uuid(), mode: z.literal("projects"),
  projects: z.array(ProjectEntry).min(1).max(1_000),
  // 旧配置无法区分自动/显式来源。按已确认升级策略迁移，仅保留历史，不把旧父目录当成授权。
  migration: z.object({ from_schema: z.literal(1), workspace: AbsolutePath, requested_workspace: AbsolutePath }).strict().optional(),
}).strict();
const Settings = z.union([LegacySettings, WorkspaceSettings, ProjectsSettings]);
type SettingsValue = z.infer<typeof Settings>;
type Entry = z.infer<typeof ProjectEntry>;
const configuredWorkspace = (value?: SettingsValue) => value && "workspace" in value ? value.workspace : null;

export const PluginConfigureInput = z.object({
  workspace: z.string().min(1).max(4096).describe("用户明确选择的绝对目录，其中包含允许使用的 Git 项目"),
  apply: z.boolean().default(false),
  expected_revision: z.uuid().nullable().optional().describe("应用设置时传入状态或预览的修订号；null 表示尚无配置"),
}).strict();

/** 个人配置保存在 Codex 用户目录，与可替换的插件版本缓存分开，升级后继续复用。 */
export class PluginSettings {
  constructor(readonly home = process.env.CODEX_HOME || join(homedir(), ".codex")) {}

  private async files(): Promise<ProjectFiles> {
    if (!isAbsolute(this.home)) throw new AppError("PLUGIN_HOME_INVALID", "CODEX_HOME 必须是已存在目录的绝对路径");
    return new ProjectFiles(await realpath(this.home));
  }

  private async read(files: ProjectFiles) {
    let raw: string;
    try { raw = await files.read(FILE, 65_536); } catch (error) {
      // 只有不存在才视为首次使用；损坏内容或读取失败需要显式报错，避免误覆盖。
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    const parsed = Settings.safeParse(JSON.parse(raw));
    if (!parsed.success || "projects" in parsed.data && new Set(parsed.data.projects.map(entry => entry.root)).size !== parsed.data.projects.length) {
      throw new AppError("PLUGIN_SETTINGS_INVALID", "插件配置无效，请检查文件后再修改");
    }
    return { raw, value: parsed.data };
  }

  /** 返回当前进程的版本和已保存配置；已安装的新版本可能尚未在这个进程生效。 */
  async status(): Promise<ToolResult> {
    const files = await this.files();
    const current = await this.read(files);
    return { outcome: "ok", code: "PLUGIN_STATUS", diagnostics: [], data: {
      version: VERSION, configured: current !== null, workspace: configuredWorkspace(current?.value),
      scope_mode: !current ? "unconfigured" : current.value.schema_version === 1 ? "legacy_pending_migration" : current.value.mode,
      projects: current && "projects" in current.value ? current.value.projects.map(entry => entry.root) : [],
      revision: current?.value.revision ?? null, settings_path: join(files.root, FILE),
      next_step: current ? "调用 project_prepare，并将当前 Git 绝对根目录作为 project"
        : "用当前 Git 绝对根目录调用 project_prepare 并传 apply: true，即可自动初始化；仅调整工作范围时才需使用 project-dev-setup",
    } };
  }

  /** 预览只读；应用时用文件锁加预期修订号，避免多个会话覆盖彼此的目录选择。 */
  async configure(raw: unknown): Promise<ToolResult> {
    const input = PluginConfigureInput.parse(raw);
    const workspace = await Workspace.open(input.workspace);
    const files = await this.files();
    if (!input.apply) {
      const current = await this.read(files);
      return { outcome: "ok", code: "PLUGIN_CONFIGURE_PREVIEW", diagnostics: [], data: {
        workspace: workspace.root, previous_workspace: configuredWorkspace(current?.value),
        expected_revision: current?.value.revision ?? null, settings_path: join(files.root, FILE),
        changes: ["将该目录保存为项目工具的工作范围，并保留全部项目记录"],
      } };
    }
    if (input.expected_revision === undefined) throw new AppError("PLUGIN_REVISION_REQUIRED", "请先预览，再传入 expected_revision；首次设置传 null");
    await files.directory("project-dev-agent");
    const release = await acquireFileLock(files, LOCK, "PLUGIN_SETTINGS_BUSY");
    try {
      // 必须拿到锁后重读；预览与执行之间，其他进程可能已经修改配置。
      const current = await this.read(files);
      if ((current?.value.revision ?? null) !== input.expected_revision) {
        throw new AppError("PLUGIN_SETTINGS_CHANGED", "预览后配置发生变化，请核对新的工作范围后再重试");
      }
      if (!current || !("workspace" in current.value) || current.value.schema_version !== 2
        || current.value.workspace !== workspace.root || current.value.requested_workspace !== resolve(input.workspace)) {
        // 同时保留规范路径与用户原路径，后续可发现路径别名被改指向其他目录的情况。
        const next = JSON.stringify({ schema_version: 2, mode: "workspace", revision: randomUUID(), workspace: workspace.root,
          requested_workspace: resolve(input.workspace) }, null, 2) + "\n";
        if (current) await files.replace(FILE, next, current.raw);
        else await files.create(FILE, next);
      }
      return await this.status();
    } finally { await release(); }
  }

  /** 自动模式逐个接入当前仓库；显式 workspace 始终保持用户选定边界。 */
  async prepare(project: string | undefined, raw: unknown): Promise<ToolResult> {
    const input = ProjectPrepareInputSchema.parse(raw);
    const files = await this.files();
    const current = await this.read(files);
    if (current?.value.schema_version === 2 && current.value.mode === "workspace")
      return prepareProject(await this.bind(project), input);
    if (!project || !isAbsolute(project)) throw new AppError("PROJECT_REQUIRED", "初始化时请传入当前 Git 工作树的绝对根目录");
    const supplied = resolve(project);
    if (current && "projects" in current.value) {
      const entry = current.value.projects.find(item => item.root === supplied || item.requested_root === supplied);
      if (entry) return prepareProject(await bindEntry(entry, project), input);
    }
    // 只校验调用方指定仓库；linked worktree 通过双向登记校验后只授权精确元数据。
    const { binding, entry } = await inspectEnrolledProject(project);
    const preview = await prepareProject(binding, { apply: false });
    if (!input.apply) return { ...preview, data: {
      ...preview.data as Record<string, unknown>,
      plugin_setup: { action: "would_initialize", workspace: binding.root, settings_path: join(files.root, FILE) },
      next_step: "调用 project_prepare 并传 apply: true，初始化当前仓库并忽略本地记录后继续开发",
    } };

    await this.enroll(files, entry);
    const prepared = await prepareProject(await this.bind(project), input);
    return { ...prepared, data: {
      ...prepared.data as Record<string, unknown>,
      plugin_setup: { action: "initialized", workspace: binding.root, settings_path: join(files.root, FILE) },
    } };
  }

  /** A/B 首次接入采用短暂有界重试；锁内合并最新白名单，不覆盖其他会话刚登记的项目。 */
  private async enroll(files: ProjectFiles, entry: Entry): Promise<void> {
    await files.directory("project-dev-agent");
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; ; attempt++) {
      try { release = await acquireFileLock(files, LOCK, "PLUGIN_SETTINGS_BUSY"); break; }
      catch (error) { if (!hasCode(error, "PLUGIN_SETTINGS_BUSY") || attempt >= 20) throw error; await delay(15); }
    }
    try {
      const current = await this.read(files);
      // 显式设置在预检之后获胜时必须服从新范围，不能把它替换回自动模式。
      if (current?.value.schema_version === 2 && current.value.mode === "workspace") {
        await this.bind(entry.requested_root); return;
      }
      await bindEntry(entry, entry.requested_root);
      const projects = current && "projects" in current.value ? current.value.projects : [];
      const existing = projects.find(item => item.root === entry.root || item.requested_root === entry.requested_root);
      if (existing) { await bindEntry(existing, entry.requested_root); return; }
      if (projects.length >= 1_000) throw new AppError("PLUGIN_PROJECT_LIMIT", "已接入项目数量达到上限，请核对插件设置");
      const migration = current?.value.schema_version === 1
        ? { from_schema: 1 as const, workspace: current.value.workspace, requested_workspace: current.value.requested_workspace }
        : current && "migration" in current.value ? current.value.migration : undefined;
      const next = JSON.stringify({ schema_version: 2, mode: "projects", revision: randomUUID(), projects: [...projects, entry],
        ...(migration ? { migration } : {}) }, null, 2) + "\n";
      // 与配置读取和原子写入共用 64 KiB 上限；达到容量时保留完整旧配置，不能留下下次读不了的文件。
      if (Buffer.byteLength(next, "utf8") > 65_536) throw new AppError("PLUGIN_PROJECT_LIMIT", "已接入项目配置达到容量上限，已保留现有配置");
      if (current) await files.replace(FILE, next, current.raw); else await files.create(FILE, next);
    } finally { await release(); }
  }

  /** 每次调用重读设置并核对原路径，配置变更或目录别名变化不会沿用旧绑定。 */
  async bind(project?: string, observe?: (context: Partial<DiagnosticContext>) => void) {
    // 只转交本次已读取的配置事实；诊断回调失败不能改变项目绑定结果。
    const report = (context: Partial<DiagnosticContext>) => { try { observe?.(context); } catch { /* 非关键诊断。 */ } };
    try {
    const settings = (await this.read(await this.files()))?.value;
    report({ scope_mode: !settings ? "unconfigured" : settings.schema_version === 1 ? "legacy" : settings.mode,
      ...(!settings ? { enrolled_project_count: 0 } : "projects" in settings ? { enrolled_project_count: settings.projects.length } : {}) });
    if (!settings) throw new AppError("PLUGIN_NOT_CONFIGURED", "用当前 Git 绝对根目录调用 project_prepare，并传 apply: true 自动初始化");
    if (!project || !isAbsolute(project)) throw new AppError("PROJECT_REQUIRED", "每次调用都需传入当前 Git 工作树的绝对根目录");
    if (settings.schema_version === 1) throw new AppError("PROJECT_NOT_ENROLLED", "旧配置待迁移；用当前 Git 根目录调用 project_prepare(apply:true)，只登记当前项目");
    if (settings.mode === "projects") {
      const supplied = resolve(project), entry = settings.projects.find(item => item.root === supplied || item.requested_root === supplied);
      if (!entry) throw new AppError("PROJECT_NOT_ENROLLED", "当前项目尚未接入；用当前 Git 根目录调用 project_prepare(apply:true)");
      const binding = await bindEntry(entry, project); report({ scope_state: "enrolled" }); return binding;
    }
    const workspace = await Workspace.open(settings.requested_workspace);
    if (workspace.root !== settings.workspace) throw new AppError("WORKSPACE_CHANGED", "已配置工作目录的标识发生变化，请核对后再重新设置");
    const binding = await workspace.bind(project); report({ scope_state: "enrolled" }); return binding;
    } catch (error) {
      if (hasCode(error, "PLUGIN_NOT_CONFIGURED") || hasCode(error, "PROJECT_NOT_ENROLLED")) report({ scope_state: "not_enrolled" });
      else if (hasCode(error, "PROJECT_OUTSIDE_WORKSPACE")) report({ scope_state: "outside" });
      else if (hasCode(error, "WORKSPACE_CHANGED")) report({ scope_state: "changed" });
      else if (hasCode(error, "PLUGIN_SETTINGS_INVALID") || hasCode(error, "PROJECT_PATH_UNSAFE")) report({ scope_state: "invalid" });
      throw error;
    }
  }
}
