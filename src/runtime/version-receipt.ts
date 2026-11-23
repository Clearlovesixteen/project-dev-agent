import { z } from "zod";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { VERSION } from "../version.js";

export const ExpectedVersion = z.string().min(1).max(80).regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/);

/** 运行版本来自已加载程序；磁盘版本来自它启动时的包目录。并存的其他缓存目录不能证明宿主选中了哪一版。 */
export async function runtimeReceipt(root: string | undefined, expected?: string) {
  let packageVersion: string | null = null, removed = false;
  if (root) {
    try {
      const data = JSON.parse(await new ProjectFiles(root).read("package.json", 65_536));
      if (data.name === "project-dev-agent" && ExpectedVersion.safeParse(data.version).success) packageVersion = data.version;
    } catch (error) { removed = hasCode(error, "ENOENT"); }
  }
  const mismatch = removed || (packageVersion !== null && packageVersion !== VERSION) || (expected !== undefined && expected !== VERSION);
  return { loaded_version: VERSION, package_version: packageVersion, expected_version: expected ?? null,
    state: mismatch ? "reload_required" as const : packageVersion ? "matched" as const : "unverified" as const };
}

export const reloadMessage = "当前 MCP 与预期版本或启动目录不一致。重新打开 Codex 会话并核对 plugin_status 的运行版本后继续，原任务保留。";
