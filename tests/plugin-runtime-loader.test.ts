import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { VERSION } from "../src/version.js";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../plugins/project-dev-agent/", import.meta.url));
const entry = join(packageRoot, "runtime/cli.mjs");

async function markerPaths(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await markerPaths(path));
    else if (entry.name === ".complete") result.push(path);
  }
  return result;
}

test("压缩运行时并发首次启动只发布完整缓存并支持复用", async t => {
  const root = await mkdtemp(join(tmpdir(), "pda-runtime-loader-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") };
  const run = () => execute(process.execPath, [entry, "doctor"], { cwd: home, env, timeout: 20_000 });
  const [first, second] = await Promise.all([run(), run()]);
  for (const result of [first, second]) {
    const doctor = JSON.parse(result.stdout);
    assert.equal(doctor.outcome, "ok");
    assert.equal(doctor.version, VERSION);
  }
  const markers = await markerPaths(join(home, ".codex/cache/project-dev-agent/runtime"));
  assert.equal(markers.length, 1);
  const cached = await execute(process.execPath, [entry, "doctor"], { cwd: home, env, timeout: 20_000 });
  assert.equal(JSON.parse(cached.stdout).version, VERSION);
});

test("压缩运行时被篡改时拒绝启动", async t => {
  const root = await mkdtemp(join(tmpdir(), "pda-runtime-integrity-")); t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "plugin"); await cp(packageRoot, installed, { recursive: true });
  const archive = join(installed, "runtime/runtime-bundle.tgz");
  const bytes = await readFile(archive); bytes[0] = (bytes[0] ?? 0) ^ 1; await writeFile(archive, bytes);
  await assert.rejects(
    execute(process.execPath, [join(installed, "runtime/cli.mjs"), "doctor"], {
      cwd: root, env: { ...process.env, HOME: root, CODEX_HOME: join(root, ".codex") }, timeout: 20_000,
    }),
    /运行包校验失败/,
  );
});
