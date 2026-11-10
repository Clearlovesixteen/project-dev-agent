import { DiagnosticWriter } from "../observability/writer.js";
import { RuntimeSettings } from "./config.js";
import { initializePublishedDiagnostics } from "./diagnostics-bootstrap.js";

/** 原生 MCP 与钩子共用启动策略；模式迁移独立于诊断开关，不扩大项目范围。 */
export async function initializePluginRuntime(home?: string) {
  const settings = new RuntimeSettings(home);
  const diagnostics = await initializePublishedDiagnostics(settings.home);
  try {
    const activation = await settings.upgradeActivation();
    if (activation.state === "migrated") await new DiagnosticWriter(settings.home).record("health.checked", {
      reason: activation.previous_mode === "manual" ? "MANUAL_UPGRADED_TO_AUTO" : "ACTIVATION_POLICY_ADOPTED",
    });
    return { diagnostics, activation };
  } catch {
    // 损坏文件和活跃锁不被重写；后续启动自动重试，不能假报已迁移或阻断整个 MCP。
    return { diagnostics, activation: { state: "unavailable" as const } };
  }
}
