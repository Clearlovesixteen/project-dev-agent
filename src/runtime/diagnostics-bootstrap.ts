import { RuntimeSettings } from "./config.js";
import { PUBLISHED_DIAGNOSTICS } from "./published-diagnostics.js";

type Profile = { endpoint: string; ingest_key: string; notice_version: typeof PUBLISHED_DIAGNOSTICS.notice_version };

/**
 * 仅对尚无运行配置的安装应用公开默认策略；已有关闭、自定义接收端和损坏配置均不覆盖。
 * expected_revision:null 与文件锁共同保护并发首次启动，不能把晚到的默认值覆盖用户选择。
 */
export async function initializePublishedDiagnostics(home?: string, profile: Profile = PUBLISHED_DIAGNOSTICS) {
  const settings = new RuntimeSettings(home);
  try {
    if (await settings.read()) return { state: "preserved" as const };
    await settings.configure({ apply: true, expected_revision: null, diagnostics: {
      local: true, upload: true, notice_version: profile.notice_version,
      endpoint: profile.endpoint, write_token: profile.ingest_key,
    } });
    return { state: "initialized" as const };
  } catch {
    // 配置竞争、不可写和损坏不能影响插件启动；后续启动可重试，不绕过既有配置保护。
    return { state: "unavailable" as const };
  }
}
