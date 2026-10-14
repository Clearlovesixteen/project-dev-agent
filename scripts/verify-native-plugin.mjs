// Runs only against an isolated CODEX_HOME and a temporary loopback Git marketplace.
// Usage: node scripts/verify-native-plugin.mjs /absolute/path/to/codex
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const codex = process.argv[2];
if (!codex) throw new Error("Pass the installed Codex CLI executable path");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "project-dev-native-upgrade-")));
const home = join(temporary, "codex-home");
const repository = join(temporary, "marketplace");
const served = join(temporary, "http");
const remote = join(served, "remote.git");
const workspaces = join(temporary, "workspaces");
const pluginId = "project-dev-agent@project-dev-team";
const execute = promisify(execFile);
const env = { ...process.env, CODEX_HOME: home };
const evidence = { verified_at: new Date().toISOString(), scenario: "Synthetic prior release to current release using native Git marketplace", steps: [] };
const clients = [];
let http;
const run = async (command, args, cwd = repository) => (await execute(command, args, { cwd, env, timeout: 30_000, maxBuffer: 4_000_000 })).stdout;
const native = async (args) => {
  const output = JSON.parse(await run(codex, [...args, "--json"]));
  evidence.steps.push({ command: ["codex", ...args], result: output }); return output;
};
const git = (args, cwd) => run("git", args, cwd);
async function connect(directory) {
  const client = new Client({ name: "native-plugin-upgrade-verification", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(directory, "runtime/cli.mjs"), "serve", "--plugin"], env, stderr: "pipe" }));
  clients.push(client); return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.structuredContent?.outcome, "error", JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
try {
  for (const directory of [home, repository, served, workspaces]) await mkdir(directory, { recursive: true });
  await cp(join(root, ".agents/plugins"), join(repository, ".agents/plugins"), { recursive: true });
  const source = join(repository, "plugins/project-dev-agent");
  await cp(join(root, "plugins/project-dev-agent"), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
  const current = manifest.version;
  const prior = `${current}-upgrade-test.1`;
  manifest.version = prior;
  await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  const bundle = await readFile(join(source, "runtime/cli.mjs"), "utf8");
  assert.equal(bundle.split(JSON.stringify(current)).length, 2, "Runtime version must occur exactly once");
  await writeFile(join(source, "runtime/cli.mjs"), bundle.replace(JSON.stringify(current), JSON.stringify(prior)));
  await git(["init", "-b", "main"]);
  const commit = async (message) => { await git(["add", "."]); await git(["-c", "user.name=Plugin test", "-c", "user.email=plugin-test@example.invalid", "commit", "-m", message]); };
  await commit("Synthetic old release for upgrade verification");
  await git(["clone", "--bare", repository, remote], temporary);
  await git(["update-server-info"], remote);
  http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const file = resolve(served, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(served + sep)) throw new Error("Invalid path");
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((done, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", done); });
  const url = `http://127.0.0.1:${http.address().port}/remote.git`;
  await native(["plugin", "marketplace", "add", url, "--ref", "main"]);
  const installed = await native(["plugin", "add", pluginId]);
  assert.equal(installed.version, prior);
  const sample = JSON.parse(await run(process.execPath, [join(installed.installedPath, "runtime/cli.mjs"), "sample", "create", "--destination", join(workspaces, "sample")]));
  const first = await connect(installed.installedPath);
  assert.equal((await call(first, "plugin_status")).data.version, prior);
  await call(first, "plugin_configure", { workspace: workspaces, apply: true, expected_revision: null });
  const task = (await call(first, "task_open", { project: sample.path, requirement: "Preserve state across native upgrade",
    acceptance_criteria: [{ id: "preserve", description: "Retain active task and workspace" }] })).data;
  const settingsBefore = await readFile(join(home, "project-dev-agent/settings.json"), "utf8");
  await first.close();
  await rm(source, { recursive: true });
  await cp(join(root, "plugins/project-dev-agent"), source, { recursive: true });
  await commit("Current release for upgrade verification");
  await git(["push", remote, "main"]);
  await git(["update-server-info"], remote);
  await native(["plugin", "marketplace", "upgrade", "project-dev-team"]);
  const refreshedPath = join(dirname(installed.installedPath), current);
  try {
    const status = JSON.parse(await run(process.execPath, [join(refreshedPath, "runtime/cli.mjs"), "plugin", "status"]));
    evidence.refresh_updates_cached_runtime = status.data.version === current;
  } catch { evidence.refresh_updates_cached_runtime = false; }
  const afterRefresh = await native(["plugin", "list"]);
  evidence.refresh_updates_installed_version = afterRefresh.installed.find((item) => item.pluginId === pluginId)?.version === current;
  // add is the native ensure-installed operation; records whether refresh alone was sufficient.
  const updated = await native(["plugin", "add", pluginId]);
  assert.equal(updated.version, current);
  const second = await connect(updated.installedPath);
  assert.equal((await call(second, "plugin_status")).data.version, current);
  assert.equal(await readFile(join(home, "project-dev-agent/settings.json"), "utf8"), settingsBefore);
  assert.equal((await call(second, "task_check", { project: sample.path })).data.recorded_task.id, task.id);
  evidence.installed_runtime_versions = [prior, current];
  evidence.workspace_and_task_preserved = true;
  evidence.result = "passed";
  await mkdir(join(root, "work"), { recursive: true });
  // Temporary paths in the detailed local log are not release artifacts.
  await writeFile(join(root, "work/native-plugin-upgrade.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ result: evidence.result, refresh_updates_installed_version: evidence.refresh_updates_installed_version,
    refresh_updates_cached_runtime: evidence.refresh_updates_cached_runtime, installed_runtime_versions: evidence.installed_runtime_versions, workspace_and_task_preserved: true }));
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (http?.listening) await new Promise((done) => http.close(done));
  await rm(temporary, { recursive: true, force: true });
}
