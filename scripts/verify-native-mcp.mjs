import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 使用宿主实际解析的插件配置连接 MCP，不能用手工拼出的正确路径代替安装验收。 */
export async function verifyNativeMcp(codex, home, cwd, expectedVersion) {
  const host = spawn(codex, ["--no-daemon", "app-server", "--stdio"], {
    cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map(); let sequence = 0;
  // 宿主还会诊断其他本地插件；不把无关日志、配置或用户材料输出到验证结果。
  host.stderr.on("data", () => {});
  const lines = createInterface({ input: host.stdout });
  lines.on("line", line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const task = pending.get(value.id); if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.reject(new Error(`HOST_PROTOCOL_${value.error.code}`)); else task.resolve(value.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`HOST_TIMEOUT_${method}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer });
    host.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "project-dev-native-mcp-verification", title: null, version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    host.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const response = await request("mcpServerStatus/list", { serverName: "project_dev", limit: 100 });
    const server = response.data.find(item => item.name === "project_dev");
    assert.ok(server, "原生宿主没有发现 project_dev MCP");
    const tools = Object.values(server.tools).map(tool => tool.name);
    assert.equal(server.toolsError ?? null, null, "原生宿主无法连接 MCP 或读取工具清单");
    assert.equal(tools.length, 16, "必须从宿主实际取得完整的 16 个工具");
    assert.ok(["plugin_status", "project_context", "task_open"].every(name => tools.includes(name)));
    if (expectedVersion) assert.equal(server.serverInfo?.version, expectedVersion);
    return { result: "passed", operation: "mcpServerStatus/list", creates_model_session: false,
      changes_trust: false, server_version: server.serverInfo?.version, tool_count: tools.length };
  } finally {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Probe closed")); }
    pending.clear(); lines.close(); host.stdin.end(); host.kill("SIGTERM");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [codex, home, cwd, version] = process.argv.slice(2);
  assert.ok(codex && home && cwd, "用法：node scripts/verify-native-mcp.mjs <codex> <CODEX_HOME> <工作目录> [版本]");
  console.log(JSON.stringify(await verifyNativeMcp(codex, home, cwd, version)));
}
