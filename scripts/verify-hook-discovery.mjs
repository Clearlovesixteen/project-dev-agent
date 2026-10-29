import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 只调用宿主的只读 hooks/list，不发起模型会话、不写钩子信任、不绕过宿主保护。 */
export async function verifyHookDiscovery(codex, home, cwd, pluginId) {
  const process = spawn(codex, ["--no-daemon", "app-server", "--stdio"], {
    cwd, env: { ...globalThis.process.env, CODEX_HOME: home, ...(globalThis.process.env.PROJECT_DEV_HOOK_DEBUG ? { RUST_LOG: "codex_core_plugins=trace,codex_core::hooks=trace" } : {}) }, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map(); let sequence = 0, stderr = "";
  process.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
  const lines = createInterface({ input: process.stdout });
  lines.on("line", line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.id === undefined) return;
    const task = pending.get(value.id); if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.reject(new Error(JSON.stringify(value.error))); else task.resolve(value.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host method timed out: ${method}; ${stderr}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer });
    process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "project-dev-hook-discovery", title: null, version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const plugins = await request("plugin/list", { cwds: [cwd], forceRefetch: false });
    const detail = await request("plugin/read", { marketplacePath: plugins.marketplaces.find(marketplace => marketplace.name === "project-dev-team").path, pluginName: "project-dev-agent" });
    const response = await request("hooks/list", { cwds: [cwd] });
    const hooks = response.data.flatMap(entry => entry.hooks).filter(hook => hook.pluginId === pluginId);
    assert.deepEqual(hooks.map(hook => hook.eventName).sort(), ["sessionStart", "stop", "userPromptSubmit"], JSON.stringify({ response, declared_hooks: detail.plugin.hooks, stderr }));
    assert.ok(hooks.every(hook => hook.handlerType === "command" && hook.source === "plugin" && hook.timeoutSec === 3));
    assert.equal(hooks.find(hook => hook.eventName === "stop").async, true);
    assert.ok(detail.plugin.mcpServers.includes("project_dev"), JSON.stringify(detail.plugin.mcpServers));
    return { result: "passed", operation: "hooks/list", creates_model_session: false, changes_trust: false,
      hooks: hooks.map(hook => ({ event: hook.eventName, enabled: hook.enabled, trust: hook.trustStatus, async: hook.async, timeout_seconds: hook.timeoutSec })),
      mcp_servers: detail.plugin.mcpServers,
      warnings: response.data.flatMap(entry => entry.warnings), errors: response.data.flatMap(entry => entry.errors) };
  } finally {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Probe closed")); }
    pending.clear(); lines.close(); process.stdin.end(); process.kill("SIGTERM");
  }
}
