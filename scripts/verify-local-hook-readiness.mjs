// 只用临时 CODEX_HOME 和本地插件源；验证宿主发现能力，不改用户安装或信任记录。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHookDiscovery } from "./verify-hook-discovery.mjs";
import { verifyNativeMcp } from "./verify-native-mcp.mjs";
import { RuntimeSettings } from "../dist/src/runtime/config.js";
import { createSample } from "../dist/src/sample/create.js";

const codex = process.argv[2];
assert.ok(codex, "需要实际 Codex CLI 的绝对路径");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await realpath(await mkdtemp(join(tmpdir(), "pda-local-hook-readiness-")));
const home = join(temp, "codex-home"); await mkdir(home);
const execute = promisify(execFile), env = { ...process.env, CODEX_HOME: home };
const evidence = { verified_at: new Date().toISOString(), changes_user_configuration: false, changes_hook_trust: false,
  creates_model_session: false, executes_development_turn: false, result: "pending" };
try {
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, diagnostics: { upload: false } });
  const sample = await createSample(join(temp, "sample"));
  for (const args of [["plugin", "marketplace", "add", root, "--json"], ["plugin", "add", "project-dev-agent@project-dev-team", "--json"]]) {
    const run = await execute(codex, args, { cwd: sample.path, env, timeout: 30_000, maxBuffer: 1_048_576 });
    const result = JSON.parse(run.stdout);
    assert.ok(!result.errors?.length, JSON.stringify(result));
  }
  evidence.hooks = await verifyHookDiscovery(codex, home, sample.path, "project-dev-agent@project-dev-team");
  evidence.mcp = await verifyNativeMcp(codex, home, sample.path, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.reason = error instanceof Error ? error.message.slice(0, 4000) : "未知错误";
  process.exitCode = 1;
} finally {
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "work/participation-native-readiness-20261110.json"), JSON.stringify(evidence, null, 2) + "\n");
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(evidence));
