import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { handleHook } from "../src/hooks/handler.js";
import { createSample } from "../src/sample/create.js";
import { TaskService } from "../src/task-service.js";
import { TaskStore } from "../src/storage/task-store.js";
import { createServer } from "../src/server.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

function git(path: string, args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: path, encoding: "utf8", stdio: "pipe" }).trim();
}
async function setup(t: test.TestContext) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const second = await createSample(join(fixture.root, "project B")), home = join(fixture.root, "home");
  await mkdir(home);
  const settings = new PluginSettings(home), config = join(home, "project-dev-agent/settings.json");
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { upload: false } });
  return { fixture, second, home, settings, config };
}
const request = (name: string) => ({ requirement: name, acceptance_criteria: [{ id: "checked", description: "检查当前项目现有代码" }] });

test("真实A→B新聊天：hook引导只接入B，两个项目的任务记录独立保留", async t => {
  const s = await setup(t);
  await s.settings.prepare(s.fixture.path, { apply: true });
  const a = (await new TaskService(await s.settings.bind(s.fixture.path)).open(request("A需求"))).data as any;
  const before = await new TaskStore(s.fixture.path).load(a.id);
  const hook = await handleHook({ hook_event_name: "SessionStart", cwd: s.second.path, session_id: "b-chat" }, "/plugin", s.home);
  assert.match((hook.hookSpecificOutput as any)?.additionalContext ?? "", /project_prepare/);
  assert.equal(hook.systemMessage, undefined);
  await s.settings.prepare(s.second.path, { apply: true });
  const b = (await new TaskService(await s.settings.bind(s.second.path)).open(request("B需求"))).data as any;
  assert.notEqual(a.id, b.id);
  assert.deepEqual(await new TaskStore(s.fixture.path).load(a.id), before);
  assert.equal((await new TaskStore(s.second.path).load(b.id)).worktree_path, s.second.path);
  const ready = await handleHook({ hook_event_name: "SessionStart", cwd: s.second.path, session_id: "b-chat" }, "/plugin", s.home);
  assert.match((ready.hookSpecificOutput as any)?.additionalContext ?? "", /自动参与入口/);
  assert.equal(ready.systemMessage, undefined);
  assert.equal(JSON.parse(await readFile(s.config, "utf8")).projects.length, 2);
});

for (const legacyScope of ["automatic-root", "explicit-root", "explicit-parent"] as const) {
  test(`旧schema1 ${legacyScope}按已确认策略迁移，只登记当前B、不扫描旧范围`, async t => {
    const s = await setup(t), workspace = legacyScope === "explicit-parent" ? s.fixture.root : s.fixture.path;
    await mkdir(join(s.home, "project-dev-agent"), { recursive: true });
    const legacy = JSON.stringify({ schema_version: 1, revision: randomUUID(), workspace, requested_workspace: workspace });
    await writeFile(s.config, legacy);
    const runtime = await readFile(join(s.home, "project-dev-agent/runtime.json"), "utf8");
    const hook = await handleHook({ hook_event_name: "SessionStart", cwd: s.second.path, session_id: "legacy-b" }, "/plugin", s.home);
    assert.match((hook.hookSpecificOutput as any)?.additionalContext ?? "", /project_prepare/);
    assert.equal(await readFile(s.config, "utf8"), legacy, "钩子本身不写范围");
    await s.settings.prepare(s.second.path, {});
    assert.equal(await readFile(s.config, "utf8"), legacy, "预览不迁移");
    await s.settings.prepare(s.second.path, { apply: true });
    const migrated = JSON.parse(await readFile(s.config, "utf8"));
    assert.equal(migrated.schema_version, 2); assert.equal(migrated.mode, "projects");
    assert.deepEqual(migrated.projects.map((entry: any) => entry.root), [s.second.path]);
    assert.deepEqual(migrated.migration, { from_schema: 1, workspace, requested_workspace: workspace });
    assert.equal(await readFile(join(s.home, "project-dev-agent/runtime.json"), "utf8"), runtime, "保留诊断关闭等运行配置");
    await assert.rejects(s.settings.bind(s.fixture.path), { code: "PROJECT_NOT_ENROLLED" });
    const saved = await readFile(s.config, "utf8"); await s.settings.prepare(s.second.path, { apply: true });
    assert.equal(await readFile(s.config, "utf8"), saved, "重试不改revision或重复登记");
    await s.settings.prepare(s.fixture.path, { apply: true });
    assert.equal(JSON.parse(await readFile(s.config, "utf8")).projects.length, 2);
  });
}

test("新显式workspace保持边界，自动prepare不扩大且保留CAS", async t => {
  const s = await setup(t);
  await s.settings.prepare(s.fixture.path, { apply: true });
  const preview = (await s.settings.configure({ workspace: s.fixture.path })).data as any;
  await s.settings.configure({ workspace: s.fixture.path, apply: true, expected_revision: preview.expected_revision });
  const saved = await readFile(s.config, "utf8");
  assert.equal(JSON.parse(saved).mode, "workspace");
  await assert.rejects(s.settings.prepare(s.second.path, { apply: true }), { code: "PROJECT_OUTSIDE_WORKSPACE" });
  await assert.rejects(s.settings.configure({ workspace: s.fixture.root, apply: true, expected_revision: preview.expected_revision }), { code: "PLUGIN_SETTINGS_CHANGED" });
  assert.equal(await readFile(s.config, "utf8"), saved);
});

test("并发旧配置迁移合并A/B，两个任务可并行建立并各自读取", async t => {
  const s = await setup(t);
  await writeFile(s.config, JSON.stringify({ schema_version: 1, revision: randomUUID(), workspace: s.fixture.path, requested_workspace: s.fixture.path }));
  await Promise.all([s.settings.prepare(s.fixture.path, { apply: true }), new PluginSettings(s.home).prepare(s.second.path, { apply: true })]);
  const tasks = await Promise.all([s.fixture.path, s.second.path].map(async (path, i) =>
    (await new TaskService(await new PluginSettings(s.home).bind(path)).open(request(`独立需求${i}`))).data as any));
  assert.notEqual(tasks[0].id, tasks[1].id);
  assert.equal((await new TaskStore(s.fixture.path).load(tasks[0].id)).worktree_path, s.fixture.path);
  assert.equal((await new TaskStore(s.second.path).load(tasks[1].id)).worktree_path, s.second.path);
  assert.equal(JSON.parse(await readFile(s.config, "utf8")).projects.length, 2);
});

test("自动登记的别名改指向B后必须拒绝，不能用prepare覆盖A的身份", async t => {
  const s = await setup(t), alias = join(s.fixture.root, "alias"); await symlink(s.fixture.path, alias);
  await s.settings.prepare(alias, { apply: true }); const saved = await readFile(s.config, "utf8");
  await unlink(alias); await symlink(s.second.path, alias);
  await assert.rejects(s.settings.bind(alias), { code: "WORKSPACE_CHANGED" });
  await assert.rejects(s.settings.prepare(alias, { apply: true }), { code: "WORKSPACE_CHANGED" });
  await assert.rejects(s.settings.bind(s.fixture.path), { code: "WORKSPACE_CHANGED" });
  assert.equal(await readFile(s.config, "utf8"), saved);
});

test("真实linked worktree可精确接入，Git公共目录的父项目和相邻项目不会因此授权", async t => {
  const s = await setup(t), linked = join(s.fixture.root, "linked B");
  git(s.fixture.path, ["worktree", "add", "-b", "parallel-requirement", linked]);
  await s.settings.prepare(linked, { apply: true });
  const binding = await s.settings.bind(linked);
  assert.equal(binding.root, await realpath(linked)); assert.equal(binding.repo_identity, join(s.fixture.path, ".git"));
  const saved = JSON.parse(await readFile(s.config, "utf8"));
  assert.equal(saved.projects.length, 1); assert.equal(saved.projects[0].root, await realpath(linked));
  assert.match(saved.projects[0].git_dir, /\.git\/worktrees\//);
  assert.match(saved.projects[0].git_file_sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(s.settings.bind(s.fixture.path), { code: "PROJECT_NOT_ENROLLED" });
  await assert.rejects(s.settings.bind(s.second.path), { code: "PROJECT_NOT_ENROLLED" });
  await s.settings.prepare(s.fixture.path, { apply: true });
  const [a, b] = await Promise.all([s.fixture.path, linked].map(async path => (await new TaskService(await s.settings.bind(path)).open(request(path))).data as any));
  assert.notEqual(a.id, b.id); assert.equal(a.repo_identity, b.repo_identity); assert.notEqual(a.worktree_path, b.worktree_path);
});

test("复制其他工作树gitfile不能伪造登记；已登记gitfile被改写后不能继续绑定", async t => {
  const s = await setup(t), linked = join(s.fixture.root, "real-linked"), fake = join(s.fixture.root, "fake-linked");
  git(s.fixture.path, ["worktree", "add", "--detach", linked]);
  await mkdir(fake); const raw = await readFile(join(linked, ".git"), "utf8"); await writeFile(join(fake, ".git"), raw);
  await assert.rejects(s.settings.prepare(fake, { apply: true }), { code: "PROJECT_PATH_UNSAFE" });
  await assert.rejects(readFile(s.config), { code: "ENOENT" });
  await s.settings.prepare(linked, { apply: true }); const saved = await readFile(s.config, "utf8");
  await writeFile(join(linked, ".git"), raw.trimEnd());
  await assert.rejects(s.settings.bind(linked), { code: "WORKSPACE_CHANGED" });
  await assert.rejects(s.settings.prepare(linked, { apply: true }), { code: "WORKSPACE_CHANGED" });
  assert.equal(await readFile(s.config, "utf8"), saved);
});

test("原生MCP仅修改运行设置可省略workspace，关闭诊断/auto不改变逐项目接入且保留CAS", async t => {
  const s = await setup(t); await s.settings.prepare(s.fixture.path, { apply: true });
  const server = createServer(project => s.settings.bind(project), undefined, s.settings);
  const client = new Client({ name: "scope-runtime-regression", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(() => client.close()); t.after(() => server.close());
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ToolResultSchema.parse((await client.callTool({ name, arguments: args })).structuredContent);
  const status = (await call("plugin_status")).data as any, saved = await readFile(s.config, "utf8");
  assert.equal(status.scope_mode, "projects"); assert.equal(status.workspace, null);
  const preview = await call("plugin_configure", { runtime: { mode: "manual", diagnostics: { upload: false, local: false } } });
  assert.equal(preview.outcome, "ok"); assert.equal(await readFile(s.config, "utf8"), saved);
  const applied = await call("plugin_configure", { apply: true, expected_revision: status.revision,
    runtime: { expected_revision: status.runtime.revision, mode: "manual", diagnostics: { upload: false, local: false } } });
  assert.equal(applied.code, "PLUGIN_RUNTIME_CONFIGURED", JSON.stringify(applied));
  assert.equal(await readFile(s.config, "utf8"), saved);
  const runtime = await new RuntimeSettings(s.home).current();
  assert.equal(runtime.mode, "manual"); assert.equal(runtime.diagnostics.local, false); assert.equal(runtime.diagnostics.upload, false);
  await s.settings.prepare(s.second.path, { apply: true });
  const stale = await call("plugin_configure", { apply: true, expected_revision: status.revision,
    runtime: { expected_revision: runtime.revision, mode: "auto" } });
  assert.equal(stale.code, "PLUGIN_SETTINGS_CHANGED");
  assert.equal((await new RuntimeSettings(s.home).current()).mode, "manual");
});

test("逐项目配置达到总字节上限时原子拒绝新增，旧配置仍可读取", async t => {
  const s = await setup(t); await s.settings.prepare(s.fixture.path, { apply: true });
  const config = JSON.parse(await readFile(s.config, "utf8"));
  // 模拟已登记但当前不必访问的旧项目；不会遍历或读取这些路径。
  for (let i = 0; i < 29; i++) {
    const root = `/not-accessed/${i}/${"x".repeat(500)}`;
    config.projects.push({ root, requested_root: root, repo_identity: `${root}/.git`, git_dir: `${root}/.git`, git_file_sha256: null });
  }
  const padding = 65_000 - Buffer.byteLength(JSON.stringify(config));
  assert.ok(padding > 0 && config.projects.at(-1).requested_root.length + padding <= 4_096);
  config.projects.at(-1).requested_root += "x".repeat(padding);
  const saved = JSON.stringify(config); assert.equal(Buffer.byteLength(saved), 65_000);
  await writeFile(s.config, saved);
  await assert.rejects(s.settings.prepare(s.second.path, { apply: true }), { code: "PLUGIN_PROJECT_LIMIT" });
  assert.equal(await readFile(s.config, "utf8"), saved);
  assert.equal((await s.settings.bind(s.fixture.path)).root, s.fixture.path);
  assert.equal((await s.settings.status()).outcome, "ok");
});

test("旧MCP运行设置携带已登记workspace仍兼容，未登记路径及过期修订号不能改配置", async t => {
  const s = await setup(t); await s.settings.prepare(s.fixture.path, { apply: true });
  const server = createServer(project => s.settings.bind(project), undefined, s.settings);
  const client = new Client({ name: "legacy-runtime-workspace", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(() => client.close()); t.after(() => server.close());
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ToolResultSchema.parse((await client.callTool({ name, arguments: args })).structuredContent);
  const status = (await call("plugin_status")).data as any, saved = await readFile(s.config, "utf8");
  const runtimeFile = join(s.home, "project-dev-agent/runtime.json"), beforeRuntime = await readFile(runtimeFile, "utf8");
  const args = { apply: true, workspace: s.fixture.path, expected_revision: status.revision,
    runtime: { expected_revision: status.runtime.revision, mode: "manual", diagnostics: { upload: false } } };
  assert.equal((await call("plugin_configure", { ...args, apply: false })).outcome, "ok");
  assert.equal((await call("plugin_configure", { ...args, workspace: s.second.path })).code, "CONFIGURATION_SEPARATE_REQUIRED");
  assert.equal((await call("plugin_configure", { ...args, expected_revision: randomUUID() })).code, "PLUGIN_SETTINGS_CHANGED");
  assert.equal((await call("plugin_configure", { ...args, runtime: { ...args.runtime, expected_revision: randomUUID() } })).code, "RUNTIME_CHANGED");
  assert.equal(await readFile(runtimeFile, "utf8"), beforeRuntime);
  assert.equal((await call("plugin_configure", args)).code, "PLUGIN_RUNTIME_CONFIGURED");
  assert.equal((await new RuntimeSettings(s.home).current()).mode, "manual");
  assert.equal(await readFile(s.config, "utf8"), saved, "不能把projects改为显式workspace或新增项目");
});
