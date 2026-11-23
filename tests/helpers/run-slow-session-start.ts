import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 运行实际发布的 SessionStart 入口，等到子进程退出后再验证输出和事件落盘。 */
export function runSlowSessionStart(home: string, input: { session_id: string; cwd: string; source?: string; prompt?: string }) {
  const preload = new URL("./slow-diagnostic-append.js", import.meta.url).href;
  const entry = fileURLToPath(new URL("../../../plugins/project-dev-agent/runtime/hooks.mjs", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", preload, entry], {
    env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 9000,
    input: JSON.stringify({ hook_event_name: "SessionStart", ...input }),
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(readFileSync(join(home, "slow-append-observed"), "utf8"), "1", "应命中真实的事件文件追加");
  const output = JSON.parse(child.stdout);
  assert.equal(child.stdout, JSON.stringify(output) + "\n", "宿主只应收到一行完整 JSON");
  return output;
}
