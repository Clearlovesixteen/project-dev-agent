import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { handleHook } from "../src/hooks/handler.js";
import { bindWorktree } from "../src/git/index.js";
import { TaskService } from "../src/task-service.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { recordRequirementSources } from "../src/quality/requirement-review.js";
import { recordValidationPlan } from "../src/quality/validation-plan.js";

const exec = promisify(execFile);
const context = (result: Record<string, unknown>) => (result.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
async function setup(t: test.TestContext) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = await mkdtemp(join(tmpdir(), "pda-participation-")); t.after(() => rm(home, { recursive: true, force: true }));
  // 隔离测试关闭上报；测试只使用真实入口与临时仓库，不触及用户配置。
  const settings = new RuntimeSettings(home);
  await settings.configure({ apply: true, expected_revision: null, diagnostics: { upload: false } });
  const plugin = new PluginSettings(home);
  await plugin.prepare(fixture.path, { apply: true });
  const binding = await bindWorktree(fixture.path);
  const call = (input: object) => handleHook({ session_id: "reliability-session", turn_id: "turn-1", cwd: fixture.path, ...input }, "/installed/project-dev-agent", home);
  return { fixture, home, settings, plugin, binding, call };
}

test("新安装默认自动参与；自然开发表达不再受关键词命中限制", async t => {
  const s = await setup(t);
  assert.equal((await s.settings.current()).mode, "auto");
  for (const prompt of ["把录音下载按钮改成失败后可重试。", "把默认页大小从20改为50。", "按钮置灰后页面还是能重复提交，处理一下。", "继续"]) {
    assert.ok(context(await s.call({ hook_event_name: "UserPromptSubmit", prompt })).includes("Project Dev Agent"), prompt);
  }
});

test("首次自动入口为自然请求提供初始化指引，不写业务文件或扩大范围", async t => {
  const s = await setup(t);
  await rm(join(s.home, "project-dev-agent/settings.json"));
  const result = await s.call({ hook_event_name: "UserPromptSubmit", prompt: "把默认页大小从20改为50。" });
  assert.ok(context(result).includes("project_prepare"));
  await assert.rejects(readFile(join(s.home, "project-dev-agent/settings.json")), { code: "ENOENT" });
});

test("缺少准备的真实修改会被修改前检查拒绝，普通读取不建任务", async t => {
  const s = await setup(t);
  const read = await s.call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rg --files" }, tool_use_id: "read-1" });
  assert.equal((read.hookSpecificOutput as any)?.permissionDecision, undefined);
  const edit = await s.call({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** End Patch" }, tool_use_id: "write-1" });
  assert.equal((edit.hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.match((edit.hookSpecificOutput as any).permissionDecisionReason, /project_context|task_open/);
});

test("准备所需哈希读取、插件 CLI 与输入中转不被自己的修改检查锁死", async t => {
  const s = await setup(t);
  for (const command of ["shasum -a 256 AGENTS.md", "node /installed/project-dev-agent/runtime/cli.mjs tools preflight",
    "node /installed/project-dev-agent/runtime/cli.mjs tools call --tool task_open --file .project-dev/local/inputs/task.json"]) {
    const result = await s.call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "prepare" });
    assert.deepEqual(result, {}, command);
  }
  const staged = { tool_name: "apply_patch", tool_use_id: "input-json", tool_input: { command: "*** Begin Patch\n*** Add File: .project-dev/local/inputs/task.json\n+{}\n*** End Patch" } };
  assert.equal((await s.call({ hook_event_name: "PreToolUse", ...staged })).hookSpecificOutput, undefined);
  assert.deepEqual(await s.call({ hook_event_name: "PostToolUse", ...staged, tool_response: "Success" }), {});
  await mkdir(join(s.fixture.path, ".project-dev/local/inputs"), { recursive: true });
  await symlink(join(s.fixture.path, "src/auth.js"), join(s.fixture.path, ".project-dev/local/inputs/task.json"));
  assert.equal(((await s.call({ hook_event_name: "PreToolUse", ...staged })).hookSpecificOutput as any)?.permissionDecision, "deny");
});

test("工作树已删除但未暂存的文件不会被当作扫描读取故障", async t => {
  const s = await setup(t), service = new UnderstandingService(s.binding);
  const files = (await exec("git", ["ls-files"], { cwd: s.fixture.path })).stdout.trim().split("\n");
  const source = files.find(path => path.endsWith(".js"))!;
  assert.ok(source);
  await unlink(join(s.fixture.path, source));
  const result = await service.scan({});
  assert.equal(result.outcome, "ok", JSON.stringify(result));
  assert.ok(!result.diagnostics.some(item => item.code === "PROJECT_FILE_UNREADABLE"));
});

test("需求与纠正引用可由服务补齐原文，提供错误引用仍被拒绝", async t => {
  const s = await setup(t);
  const task = { requirement: "保留用户原始需求全文", corrections: [] };
  const sources = await recordRequirementSources(s.binding, task, [], [{ id: "request", kind: "request" }]);
  assert.equal(sources[0]?.input.quote, task.requirement);
  await assert.rejects(recordRequirementSources(s.binding, task, [], [{ id: "bad", kind: "request", quote: "模型编造的原文" }]), { code: "REQUIREMENT_SOURCE_INVALID" });
});

test("缺失检查配置返回可定位的稳定错误，不再退化为 OPERATION_FAILED", async t => {
  const s = await setup(t);
  await assert.rejects(recordValidationPlan(s.binding, { checks: [{ id: "lint", description: "样式检查", command: "node", args: ["--version"], cwd: ".", timeout_ms: 1000, source_paths: [".stylelintrc.js"], acceptance_ids: ["a"] }] }, ["a"]), (error: any) => {
    assert.equal(error.code, "VALIDATION_SOURCE_MISSING");
    assert.match(error.message, /lint/); assert.match(error.message, /\.stylelintrc\.js/);
    return true;
  });
});

test("切换分支创建新任务保留旧分支任务，切回后恢复原任务", async t => {
  const s = await setup(t), tasks = new TaskService(s.binding);
  const input = { requirement: "完成当前分支需求", acceptance_criteria: [{ id: "a", description: "行为符合需求" }] };
  const first = await tasks.open(input); assert.equal(first.code, "TASK_OPENED");
  await exec("git", ["switch", "-c", "reliability-next"], { cwd: s.fixture.path });
  const second = await new TaskService(await bindWorktree(s.fixture.path)).open(input);
  assert.equal(second.code, "TASK_OPENED", JSON.stringify(second));
  await exec("git", ["switch", "main"], { cwd: s.fixture.path });
  const checked = await tasks.check({});
  assert.equal((checked.data as any)?.task_id, (first.data as any).id);
});
