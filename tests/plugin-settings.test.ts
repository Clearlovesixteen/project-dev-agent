import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PluginSettings } from "../src/plugin-settings.js";
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
