import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PluginSettings } from "../src/plugin-settings.js";
import { createSample } from "../src/sample/create.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("plugin setup previews without writes, persists across instances, and requires the current revision", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const settings = new PluginSettings(home);
  assert.equal((await settings.status()).code, "PLUGIN_STATUS");
  const preview = (await settings.configure({ workspace: fixture.root })).data as { expected_revision: null };
  assert.equal(preview.expected_revision, null);
  await assert.rejects(readFile(join(home, "project-dev-agent/settings.json")), { code: "ENOENT" });
  await assert.rejects(settings.bind(fixture.path), { code: "PLUGIN_NOT_CONFIGURED" });
  await assert.rejects(settings.configure({ workspace: fixture.root, apply: true }), { code: "PLUGIN_REVISION_REQUIRED" });
  const configured = (await settings.configure({ workspace: fixture.root, apply: true, expected_revision: null })).data as { revision: string; workspace: string };
  assert.equal(configured.workspace, await realpath(fixture.root));
  const restarted = new PluginSettings(home);
  assert.equal((await restarted.bind(fixture.path)).root, await realpath(fixture.path));
  await assert.rejects(restarted.bind(), { code: "PROJECT_REQUIRED" });
  await assert.rejects(restarted.bind("/outside-workspace"), { code: "PROJECT_OUTSIDE_WORKSPACE" });
  await assert.rejects(settings.configure({ workspace: fixture.path, apply: true, expected_revision: null }), { code: "PLUGIN_SETTINGS_CHANGED" });
  await settings.configure({ workspace: fixture.path, apply: true, expected_revision: configured.revision });
  assert.equal(((await restarted.status()).data as { workspace: string }).workspace, await realpath(fixture.path));
});

test("plugin configuration preserves malformed files and refuses locks and symlink settings", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(join(home, "project-dev-agent"), { recursive: true });
  const settings = new PluginSettings(home);
  const file = join(home, "project-dev-agent/settings.json");
  await writeFile(file, '{"schema_version":99}');
  await assert.rejects(settings.configure({ workspace: fixture.root, apply: true, expected_revision: null }), { code: "PLUGIN_SETTINGS_INVALID" });
  assert.equal(await readFile(file, "utf8"), '{"schema_version":99}');
  await unlink(file);
  const lock = join(home, "project-dev-agent/settings.lock");
  await writeFile(lock, "another process");
  await assert.rejects(settings.configure({ workspace: fixture.root, apply: true, expected_revision: null }), { code: "PLUGIN_SETTINGS_BUSY" });
  assert.equal(await readFile(lock, "utf8"), "another process");
  await unlink(lock);
  const elsewhere = join(fixture.root, "external-settings"); await writeFile(elsewhere, "preserve"); await symlink(elsewhere, file);
  await assert.rejects(settings.status(), { code: "PATH_UNSAFE" });
  await assert.rejects(settings.configure({ workspace: fixture.root, apply: true, expected_revision: null }), { code: "PATH_UNSAFE" });
  assert.equal(await readFile(elsewhere, "utf8"), "preserve");
});

test("two plugin configuration writers cannot both replace the same preview", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const a = new PluginSettings(home); const b = new PluginSettings(home);
  const attempts = await Promise.allSettled([a.configure({ workspace: fixture.root, apply: true, expected_revision: null }),
    b.configure({ workspace: fixture.path, apply: true, expected_revision: null })]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await a.status()).outcome, "ok");
});

test("plugin detects a workspace symlink redirected after configuration", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const alias = join(fixture.root, "workspace-alias"); await symlink(fixture.path, alias);
  const settings = new PluginSettings(home);
  await settings.configure({ workspace: alias, apply: true, expected_revision: null });
  await unlink(alias); await symlink(home, alias);
  await assert.rejects(settings.bind(fixture.path), { code: "WORKSPACE_CHANGED" });
});

test("first project use previews without writes, then initializes only that repository and preserves dirty files", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const settings = new PluginSettings(home);
  const config = join(home, "project-dev-agent/settings.json");
  // Remove the fixture's ignore without committing: initialization must also work with existing edits.
  const ignore = join(fixture.path, ".gitignore"); await writeFile(ignore, "node_modules/\n");
  const instructions = await readFile(join(fixture.path, "AGENTS.md"));
  const exclude = join(fixture.path, ".git/info/exclude");
  const preview = (await settings.prepare(fixture.path, {})).data as {
    plugin_setup: { action: string; workspace: string }; state_ignored: boolean;
  };
  assert.equal(preview.plugin_setup.action, "would_initialize");
  assert.equal(preview.plugin_setup.workspace, await realpath(fixture.path));
  assert.equal(preview.state_ignored, false);
  await assert.rejects(readFile(config), { code: "ENOENT" });
  await assert.rejects(readFile(exclude), { code: "ENOENT" });
  const applied = (await settings.prepare(fixture.path, { apply: true })).data as {
    plugin_setup: { action: string }; state_ignored: boolean; worktree_clean: boolean;
  };
  assert.equal(applied.plugin_setup.action, "initialized");
  assert.equal(applied.state_ignored, true);
  assert.equal(applied.worktree_clean, false);
  const saved = await readFile(config, "utf8"), excluded = await readFile(exclude, "utf8");
  assert.equal(JSON.parse(saved).workspace, await realpath(fixture.path));
  assert.match(excluded, /\/\.project-dev\/local\//);
  await new PluginSettings(home).prepare(fixture.path, { apply: true });
  assert.equal(await readFile(config, "utf8"), saved);
  assert.equal(await readFile(exclude, "utf8"), excluded);
  assert.equal(await readFile(ignore, "utf8"), "node_modules/\n");
  assert.deepEqual(await readFile(join(fixture.path, "AGENTS.md")), instructions);
  await assert.rejects(settings.prepare(fixture.root, { apply: true }), { code: "PROJECT_OUTSIDE_WORKSPACE" });
  assert.equal(await readFile(config, "utf8"), saved);
});

test("automatic preparation reuses an existing multi-project workspace without rewriting its settings", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const second = await createSample(join(fixture.root, "second project"));
  const home = join(fixture.root, "codex"); await mkdir(home);
  const settings = new PluginSettings(home);
  await settings.configure({ workspace: fixture.root, apply: true, expected_revision: null });
  const config = join(home, "project-dev-agent/settings.json"), saved = await readFile(config, "utf8");
  assert.equal((await settings.prepare(fixture.path, { apply: true })).outcome, "ok");
  assert.equal((await settings.prepare(second.path, { apply: true })).outcome, "ok");
  assert.equal(await readFile(config, "utf8"), saved);
});

test("invalid roots and unsafe local state cannot initialize the plugin", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(home);
  const settings = new PluginSettings(home);
  await assert.rejects(settings.prepare(undefined, { apply: true }), { code: "PROJECT_REQUIRED" });
  await assert.rejects(settings.prepare("relative", { apply: true }), { code: "PROJECT_REQUIRED" });
  await assert.rejects(settings.prepare(fixture.root, { apply: true }), { code: "NOT_GIT_WORKTREE" });
  await assert.rejects(settings.prepare(join(fixture.path, "src"), { apply: true }), { code: "WORKTREE_ROOT_REQUIRED" });
  await symlink(home, join(fixture.path, ".project-dev"));
  await assert.rejects(settings.prepare(fixture.path, { apply: true }), { code: "PATH_UNSAFE" });
  await assert.rejects(readFile(join(home, "project-dev-agent/settings.json")), { code: "ENOENT" });
});

test("automatic initialization preserves malformed settings and another writer's lock", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex"); await mkdir(join(home, "project-dev-agent"), { recursive: true });
  const settings = new PluginSettings(home), config = join(home, "project-dev-agent/settings.json");
  await writeFile(config, '{"schema_version":99}');
  await assert.rejects(settings.prepare(fixture.path, { apply: true }), { code: "PLUGIN_SETTINGS_INVALID" });
  assert.equal(await readFile(config, "utf8"), '{"schema_version":99}');
  await unlink(config);
  const lock = join(home, "project-dev-agent/settings.lock"); await writeFile(lock, "another process");
  await assert.rejects(settings.prepare(fixture.path, { apply: true }), { code: "PLUGIN_SETTINGS_BUSY" });
  assert.equal(await readFile(lock, "utf8"), "another process");
  await assert.rejects(readFile(config), { code: "ENOENT" });
});

test("concurrent first use in different projects cannot replace the winning workspace", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const second = await createSample(join(fixture.root, "second project"));
  const home = join(fixture.root, "codex"); await mkdir(home);
  const attempts = await Promise.allSettled([
    new PluginSettings(home).prepare(fixture.path, { apply: true }),
    new PluginSettings(home).prepare(second.path, { apply: true }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const saved = JSON.parse(await readFile(join(home, "project-dev-agent/settings.json"), "utf8"));
  const winner = attempts[0]!.status === "fulfilled" ? fixture.path : second.path;
  assert.equal(saved.workspace, await realpath(winner));
  const failed = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(["PLUGIN_SETTINGS_CHANGED", "PLUGIN_SETTINGS_BUSY", "PROJECT_OUTSIDE_WORKSPACE"].includes(failed.reason.code));
});
test("配置遗留锁自动恢复，仍存活或无法识别的锁继续保留", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "codex-lock-recovery"); await mkdir(join(home, "project-dev-agent"), { recursive: true });
  const lock = join(home, "project-dev-agent/settings.lock");
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim());
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  await writeFile(lock, JSON.stringify({ pid: deadPid }));
  const settings = new PluginSettings(home);
  assert.equal((await settings.configure({ workspace: fixture.path, apply: true, expected_revision: null })).outcome, "ok");
  await assert.rejects(readFile(lock), { code: "ENOENT" });
  const revision = ((await settings.status()).data as any).revision;
  const live = JSON.stringify({ pid: process.pid, token: "live-writer" });
  await writeFile(lock, live);
  await assert.rejects(settings.configure({ workspace: fixture.path, apply: true, expected_revision: revision }), { code: "PLUGIN_SETTINGS_BUSY" });
  assert.equal(await readFile(lock, "utf8"), live);
});

test("并发恢复遗留配置锁时只允许一个写入者成功", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(fixture.root, "recovery-race"); await mkdir(join(home, "project-dev-agent"), { recursive: true });
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim());
  await writeFile(join(home, "project-dev-agent/settings.lock"), JSON.stringify({ pid: deadPid }));
  await writeFile(join(home, "project-dev-agent/settings.lock.recover"), JSON.stringify({ pid: deadPid }));
  const attempts = await Promise.allSettled([
    new PluginSettings(home).configure({ workspace: fixture.root, apply: true, expected_revision: null }),
    new PluginSettings(home).configure({ workspace: fixture.path, apply: true, expected_revision: null }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const failure = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(["PLUGIN_SETTINGS_BUSY", "PLUGIN_SETTINGS_CHANGED"].includes(failure.reason.code));
  await assert.rejects(readFile(join(home, "project-dev-agent/settings.lock")), { code: "ENOENT" });
});
