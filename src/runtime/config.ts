import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { hasCode, ProjectFiles } from "../storage/project-files.js";
import { PUBLISHED_DIAGNOSTICS } from "./published-diagnostics.js";

export const DIAGNOSTIC_NOTICE = "2026-10-29-v1";
export const RUNTIME_DIRECTORY = "project-dev-agent";
const CONFIG_FILE = `${RUNTIME_DIRECTORY}/runtime.json`;

/** 接收端来自发布者公开默认策略或用户配置；仅回环允许 HTTP，便于本地测试。 */
export const CollectorEndpoint = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname));
}, "诊断接收地址须使用 HTTPS，或本机回环 HTTP，且不能含凭证、查询参数或片段");

const Diagnostics = z.object({
  local: z.boolean().default(true),
  upload: z.boolean().default(false),
  notice_version: z.literal(DIAGNOSTIC_NOTICE).nullable().default(null),
  endpoint: CollectorEndpoint.nullable().default(null),
  enabled_at: z.string().datetime().nullable().default(null),
  upload_epoch: z.uuid().nullable().default(null),
  // 兼容公开接收标识和私有写入凭证；保存为 0600，状态输出和遥测均不返回其值。
  write_token: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/).nullable().default(null),
}).strict();

export const RuntimeConfiguration = z.object({
  schema_version: z.literal(1), revision: z.uuid(),
  mode: z.enum(["manual", "observe", "auto"]).default("manual"),
  diagnostics: Diagnostics,
}).strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfiguration>;

// Zod 4 的 default 在 partial 字段缺失时也可能生效。补丁必须移除默认值，防止关上传时清空凭证。
const DiagnosticsPatch = z.object({
  use_default: z.boolean().optional(),
  local: Diagnostics.shape.local.removeDefault().optional(),
  upload: Diagnostics.shape.upload.removeDefault().optional(),
  notice_version: Diagnostics.shape.notice_version.removeDefault().optional(),
  endpoint: Diagnostics.shape.endpoint.removeDefault().optional(),
  write_token: Diagnostics.shape.write_token.removeDefault().optional(),
}).strict();

export const RuntimeConfigureInput = z.object({
  apply: z.boolean().default(false),
  expected_revision: z.uuid().nullable().optional(),
  mode: z.enum(["manual", "observe", "auto"]).optional(),
  diagnostics: DiagnosticsPatch.optional(),
}).strict();

export function codexDirectory(): string { return process.env.CODEX_HOME || join(homedir(), ".codex"); }
export async function runtimeFiles(home = codexDirectory()): Promise<ProjectFiles> {
  if (!isAbsolute(home)) throw new AppError("PLUGIN_HOME_INVALID", "Codex 用户目录须为绝对路径");
  return new ProjectFiles(await realpath(home));
}

/** 与旧 settings.json 分开保存，升级不会重写已验证的工作范围。 */
export class RuntimeSettings {
  constructor(readonly home = codexDirectory()) {}

  async read(): Promise<RuntimeConfig | null> {
    const files = await runtimeFiles(this.home);
    try { return RuntimeConfiguration.parse(JSON.parse(await files.read(CONFIG_FILE))); }
    catch (error) { if (hasCode(error, "ENOENT")) return null; throw new AppError("RUNTIME_CONFIG_INVALID", "运行设置无效，已保留原文件"); }
  }

  async current(): Promise<RuntimeConfig> {
    return await this.read() ?? RuntimeConfiguration.parse({ schema_version: 1, revision: randomUUID(), mode: "manual", diagnostics: {} });
  }

  async status() {
    const config = await this.read();
    return {
      configured: !!config, revision: config?.revision ?? null, mode: config?.mode ?? "manual",
      diagnostics: { local: config?.diagnostics.local ?? true, upload: config?.diagnostics.upload ?? false,
        notice_version: config?.diagnostics.notice_version ?? null, endpoint: config?.diagnostics.endpoint ?? null,
        credential_configured: !!config?.diagnostics.write_token,
        collector_kind: !config?.diagnostics.write_token ? "unconfigured" : config.diagnostics.write_token === PUBLISHED_DIAGNOSTICS.ingest_key
          && config.diagnostics.endpoint === PUBLISHED_DIAGNOSTICS.endpoint ? "published_public_ingest" : "custom" },
      notice: "新安装默认向插件维护者发送版本、功能结果、错误码、耗时与去标识链路；不含代码、需求或对话正文。可随时关闭，已保存的关闭及自定义配置不会因更新被覆盖。",
      required_notice_version: DIAGNOSTIC_NOTICE,
    };
  }

  async configure(value: unknown) {
    const input = RuntimeConfigureInput.parse(value), files = await runtimeFiles(this.home);
    const proposed = async () => {
      const prior = await this.read(), base = prior ?? await this.current();
      const { use_default, ...patch } = input.diagnostics ?? {};
      if (use_default && (patch.endpoint !== undefined || patch.write_token !== undefined))
        throw new AppError("DIAGNOSTICS_DEFAULT_CONFLICT", "默认接收策略不能同时指定另一组地址或凭证");
      const published = use_default ? { upload: true, notice_version: DIAGNOSTIC_NOTICE,
        endpoint: PUBLISHED_DIAGNOSTICS.endpoint, write_token: PUBLISHED_DIAGNOSTICS.ingest_key } : {};
      const diagnostics = { ...base.diagnostics, ...published, ...patch };
      if (!diagnostics.local) diagnostics.upload = false;
      if (!diagnostics.upload) { diagnostics.enabled_at = null; diagnostics.upload_epoch = null; }
      else if (!base.diagnostics.upload || !base.diagnostics.upload_epoch || base.diagnostics.endpoint !== diagnostics.endpoint || base.diagnostics.write_token !== diagnostics.write_token) {
        diagnostics.enabled_at = new Date().toISOString(); diagnostics.upload_epoch = randomUUID();
      }
      if (diagnostics.upload && (diagnostics.notice_version !== DIAGNOSTIC_NOTICE || !diagnostics.endpoint || !diagnostics.write_token)) {
        throw new AppError("DIAGNOSTICS_SETUP_REQUIRED", "远程上报需要先明确说明并启用，同时配置接收地址和写入凭证");
      }
      return { prior, next: RuntimeConfiguration.parse({ ...base, mode: input.mode ?? base.mode, diagnostics, revision: randomUUID() }) };
    };
    if (!input.apply) {
      const { prior, next } = await proposed();
      return { preview: true, expected_revision: prior?.revision ?? null, mode: next.mode,
        diagnostics: { ...next.diagnostics, write_token: undefined, credential_configured: !!next.diagnostics.write_token } };
    }
    if (input.expected_revision === undefined) throw new AppError("RUNTIME_REVISION_REQUIRED", "保存运行设置需要预览修订号，首次保存使用 null");
    await files.directory(RUNTIME_DIRECTORY);
    const release = await acquireFileLock(files, `${RUNTIME_DIRECTORY}/runtime.lock`, "RUNTIME_BUSY");
    try {
      const { prior, next } = await proposed();
      if ((prior?.revision ?? null) !== input.expected_revision) throw new AppError("RUNTIME_CHANGED", "运行设置已变化，请重新读取后保存");
      const raw = JSON.stringify(next) + "\n";
      if (prior) await files.replace(CONFIG_FILE, raw, await files.read(CONFIG_FILE));
      else await files.create(CONFIG_FILE, raw);
    } finally { await release(); }
    // 关闭后丢弃待发送事件；本地分析事件保留，上传器也会在每一批前重新检查设置。
    return this.status();
  }
}
