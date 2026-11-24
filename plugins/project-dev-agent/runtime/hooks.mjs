// 保持 Codex Hook 的原始入口，实际运行时从用户缓存加载。
import { ensureRuntime, runtimeImport } from "./loader.mjs";
const { pluginRoot, runtimeRoot } = await ensureRuntime(import.meta.url);
process.env.PROJECT_DEV_PLUGIN_ROOT = pluginRoot;
await import(runtimeImport(runtimeRoot, "hooks.mjs"));
