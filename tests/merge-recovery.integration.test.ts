import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { PluginSettings } from "../src/plugin-settings.js";
import { RuntimeSettings } from "../src/runtime/config.js";
import { createServer } from "../src/server.js";
import { handleHook } from "../src/hooks/handler.js";
import { DiagnosticWriter } from "../src/observability/writer.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { TaskStore } from "../src/storage/task-store.js";
import { bindWorktree } from "../src/git/index.js";
import { baselineContent } from "../src/git/workspace-baseline.js";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const restore = "git restore --source=origin/fix/runtime-compatibility-baseline --staged --worktree -- pnpm-lock.yaml";
async function setup(t: test.TestContext, currentTask = false) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: fixture.path, encoding: "utf8", stdio: "pipe" }).trim();
  await writeFile(join(fixture.path, "pnpm-lock.yaml"), "lockfileVersion: base\n"); git(["add", "pnpm-lock.yaml"]); git(["commit", "-m", "lock baseline"]);
  const home = join(fixture.root, "home"); await mkdir(home);
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { upload: false } });
  const plugin = new PluginSettings(home), server = createServer(project => plugin.bind(project), undefined, plugin);
  const client = new Client({ name: "merge-recovery-regression", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(() => client.close()); t.after(() => server.close());
  const session = { session_id: "merge-owner", turn_id: "merge-turn" };
  const hook = (input: object) => handleHook({ cwd: fixture.path, ...session, ...input }, "/installed/project-dev-agent", home);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const prepared = await hook({ hook_event_name: "PreToolUse", tool_name: `mcp__project_dev__${name}`, tool_input: { project: fixture.path, ...args } });
    const native = prepared.hookSpecificOutput as any;
    assert.notEqual(native?.permissionDecision, "deny", JSON.stringify(prepared));
    return ToolResultSchema.parse((await client.callTool({ name, arguments: native?.updatedInput ?? { project: fixture.path, ...args } })).structuredContent);
  };
  await call("project_prepare", { apply: true });
  const previous = await call("task_open", { requirement: "保留其他分支的原始任务", acceptance_criteria: [{ id: "keep", description: "保留原任务" }] });
  assert.equal(previous.outcome, "ok"); const oldTask = previous.data as any;
  git(["checkout", "-b", "incoming"]); await writeFile(join(fixture.path, "pnpm-lock.yaml"), "lockfileVersion: incoming\n"); git(["add", "pnpm-lock.yaml"]); git(["commit", "-m", "incoming lock"]);
  git(["checkout", "-b", "test", "main"]); await writeFile(join(fixture.path, "pnpm-lock.yaml"), "lockfileVersion: preferred\n"); git(["add", "pnpm-lock.yaml"]); git(["commit", "-m", "preferred lock"]);
  git(["update-ref", "refs/remotes/origin/fix/runtime-compatibility-baseline", "HEAD"]);
  const taskBeforeMerge = currentTask ? (await call("task_open", { requirement: "同一分支原开发任务，需挂起后处理冲突", acceptance_criteria: [{ id: "resume", description: "保留任务可继续" }] })).data as any : undefined;
  assert.throws(() => git(["merge", "--no-commit", "incoming"]));
  assert.equal(git(["diff", "--name-only", "--diff-filter=U"]), "pnpm-lock.yaml");
  await call("project_prepare", { apply: true }); await call("project_scan");
  await call("project_context", { query: "修复锁文件冲突，保留已有兼容性版本", paths: ["pnpm-lock.yaml", "AGENTS.md"] });
  const request = await withImplementationBasis(fixture.path, { requirement: "解决当前冲突，以fix/runtime-compatibility-baseline为主", scope_paths: ["pnpm-lock.yaml"], acceptance_criteria: [{ id: "lock", description: "冲突消除且使用指定分支锁文件" }] });
  const write = (command = restore) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "merge-write", tool_input: { command } });
  const open = (source = true) => call("task_open", { ...request, task_kind: "merge_recovery", ...(source ? { resolution_source: "origin/fix/runtime-compatibility-baseline" } : {}) });
  const patch = (path = "pnpm-lock.yaml", session_id = session.session_id) => hook({ session_id, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "merge-patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n+// recovery\n*** End Patch` } });
  return { fixture, git, call, hook, write, patch, open, request, oldTask, taskBeforeMerge, session, home };
}

test("真实单锁文件UU冲突：task_open不能与指定来源restore形成双向阻塞", async t => {
  const s = await setup(t), before = await readFile(join(s.fixture.path, "pnpm-lock.yaml"), "utf8");
  assert.equal((await s.call("task_open", s.request)).code, "UNMERGED_CHANGES", "普通任务仍拒绝冲突");
  assert.equal(((await s.write()).hookSpecificOutput as any)?.permissionDecision, "deny", "无恢复任务仍拒绝写入");
  const opened = await s.call("task_open", { ...s.request, task_kind: "merge_recovery", resolution_source: "origin/fix/runtime-compatibility-baseline" }), guard = await s.write();
  assert.equal(await readFile(join(s.fixture.path, "pnpm-lock.yaml"), "utf8"), before);
  assert.deepEqual(await new TaskStore(s.fixture.path).load(s.oldTask.id), s.oldTask);
  assert.equal(opened.code, "TASK_OPENED", JSON.stringify(opened));
  assert.notEqual((guard.hookSpecificOutput as any)?.permissionDecision, "deny", JSON.stringify(guard));
  const task = opened.data as any;
  const observed = (await new DiagnosticWriter(s.home).read()).events.filter(event => event.reason_code === "WRITE_READY").at(-1)!;
  assert.deepEqual({ merge: observed.context?.merge_state, remaining: observed.context?.conflict_count, source: observed.context?.recovery_source,
    target: observed.context?.target_scope, task: observed.context?.task_kind, family: observed.context?.command_family },
  { merge: "unmerged", remaining: 1, source: "matched", target: "within", task: "merge_recovery", family: "git_restore" });
  assert.ok(!JSON.stringify(observed).includes("pnpm-lock.yaml")); assert.ok(!JSON.stringify(observed).includes("runtime-compatibility-baseline"));
  // 使用正式entry里的1500/1800ms预算；直接调用handleHook不能验证宿主时限。
  const entry = join(s.fixture.root, "packaged/runtime/hooks.mjs"); await mkdir(join(s.fixture.root, "packaged/runtime"), { recursive: true });
  await build({ entryPoints: [fileURLToPath(new URL("../src/hooks/entry.js", import.meta.url))], bundle: true, platform: "node", format: "esm", minify: true, target: "node18.19", outfile: entry, logLevel: "silent",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const started = performance.now();
  const actual = await new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, CODEX_HOME: s.home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("真实钩子未退出")); }, 5000);
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", cwd: s.fixture.path, ...s.session, tool_name: "Bash", tool_use_id: "packaged-recovery", tool_input: { command: restore } }));
  });
  t.diagnostic(`packaged recovery PreToolUse=${Math.round(performance.now() - started)}ms ${JSON.stringify(actual)}`);
  assert.notEqual(actual.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(actual));
  const packagedOperation = await new DiagnosticWriter(s.home).opaque("packaged-recovery");
  const packagedEvent = (await new DiagnosticWriter(s.home).read()).events.find(event => event.operation_id === packagedOperation && event.reason_code === "WRITE_READY");
  assert.equal(packagedEvent?.context?.merge_state, "unmerged", "真实宿主退出前已持久化门禁事实");
  assert.equal(packagedEvent?.context?.recovery_source, "matched");
  assert.equal(await baselineContent(await bindWorktree(s.fixture.path), task.baseline_head, "pnpm-lock.yaml", task.workspace_baseline), before, "冲突前镜像能由正式基线读取入口完整还原");
  assert.equal((await s.call("task_check", { task_id: task.id })).code, "UNMERGED_CHANGES");
  assert.equal((await s.call("task_update", { task_id: task.id, expected_revision: 0, phase: "closed" })).code, "UNMERGED_CHANGES");
  s.session.turn_id = "continue-recovery-next-turn";
  const continued = await s.call("task_check", { task_id: task.id }); assert.equal(continued.code, "UNMERGED_CHANGES"); assert.equal(continued.outcome, "incomplete");
  assert.notEqual(((await s.write()).hookSpecificOutput as any)?.permissionDecision, "deny", "跨轮继续未解冲突任务不能再次形成门禁循环");
  s.git(["restore", "--source=origin/fix/runtime-compatibility-baseline", "--staged", "--worktree", "--", "pnpm-lock.yaml"]);
  assert.equal(s.git(["ls-files", "--unmerged"]), "");
  assert.equal(await readFile(join(s.fixture.path, "pnpm-lock.yaml"), "utf8"), "lockfileVersion: preferred\n");
  assert.deepEqual(await new TaskStore(s.fixture.path).load(s.oldTask.id), s.oldTask);
  const checked = await s.call("task_check", { task_id: task.id });
  assert.equal(checked.outcome, "incomplete", "解决冲突不冒充完整验收");
  assert.ok((checked.data as any).review_snapshot, JSON.stringify(checked));
  assert.equal((checked.data as any).merge_recovery.state, "resolved_uncommitted");
  const validation = `node /installed/project-dev-agent/runtime/cli.mjs validation run --project '${s.fixture.path}' --task-id ${task.id} --check-id project-tests`;
  assert.notEqual(((await s.write(validation)).hookSpecificOutput as any)?.permissionDecision, "deny");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: s.home }; delete env.NODE_TEST_CONTEXT;
  const run = JSON.parse(execFileSync(process.execPath, [cli, "validation", "run", "--project", s.fixture.path, "--task-id", task.id, "--check-id", "project-tests"], { env, encoding: "utf8", timeout: 15000 }));
  assert.equal(run.outcome, "ok", JSON.stringify(run)); assert.equal(run.data.exit_code, 0); assert.match(run.data.output, /# fail 0/);
  const evidence = [{ kind: "manual", reference: "pnpm-lock.yaml", summary: "实际核对指定来源锁文件内容、零未合并条目与真实样例测试" }];
  const reviewed = await s.call("task_update", { task_id: task.id, expected_revision: 0, review_snapshot: (checked.data as any).review_snapshot,
    change_items: task.change_items.map((item: any) => ({ ...item, status: "checked", reviewed_by: "fixture", evidence })),
    acceptance_criteria: task.acceptance_criteria.map((item: any) => ({ ...item, status: "checked", reviewed_by: "fixture", evidence })),
    validations: [{ id: "actual-tests", description: "真实运行已保存测试计划", outcome: "passed", run_id: (run.data as any).id, evidence }] });
  assert.equal(reviewed.outcome, "ok", JSON.stringify(reviewed));
  assert.equal((await s.call("task_update", { task_id: task.id, expected_revision: 1, phase: "closed" })).outcome, "ok");
});

test("恢复任务仅原冲突路径和固定来源可写，拒绝脚本/复合命令/无关路径及跨会话接管", async t => {
  const s = await setup(t), opened = await s.open(), task = opened.data as any; assert.equal(opened.outcome, "ok", JSON.stringify(opened));
  const indexBefore = s.git(["ls-files", "--stage"]), before = await readFile(join(s.fixture.path, "pnpm-lock.yaml"), "utf8");
  for (const command of [
    "git add -- src/auth.js", "git add -A -- pnpm-lock.yaml", "git add -- .", "git add -- '*.yaml'",
    "git restore --source=incoming --staged --worktree -- pnpm-lock.yaml", restore + " src/auth.js",
    restore + "; node -e 'require(\"fs\").writeFileSync(\"unrelated\",\"x\")'", "git reset --hard", "node -e 'console.log(1)'",
    `node /other/runtime/cli.mjs validation run --project '${s.fixture.path}' --task-id ${task.id} --check-id project-tests`,
    `/tmp/custom/node /installed/project-dev-agent/runtime/cli.mjs validation run --project '${s.fixture.path}' --task-id ${task.id} --check-id project-tests`,
  ]) assert.equal(((await s.write(command)).hookSpecificOutput as any)?.permissionDecision, "deny", command);
  assert.equal(((await s.patch("src/auth.js")).hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.equal(((await s.patch("../outside.js")).hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.equal(((await s.patch("src/../pnpm-lock.yaml")).hookSpecificOutput as any)?.permissionDecision, "deny");
  s.session.session_id = "another-owner"; s.session.turn_id = "another-turn";
  await s.call("project_context", { query: "冲突只读排查", paths: ["pnpm-lock.yaml"] }); await s.call("task_check", { task_id: task.id });
  const denied = await s.patch(); assert.equal((denied.hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.match((denied.hookSpecificOutput as any).permissionDecisionReason, /另一聊天/);
  assert.equal(s.git(["ls-files", "--stage"]), indexBefore); assert.equal(await readFile(join(s.fixture.path, "pnpm-lock.yaml"), "utf8"), before);
  assert.equal((await new TaskStore(s.fixture.path).load(task.id)).owner?.session_id, "merge-owner");
});

test("未指定来源可手工修复且补依据，暂存后仍有markers不能验收；范围外新改动不能借恢复任务处理", async t => {
  const s = await setup(t); await writeFile(join(s.fixture.path, "preexisting.js"), "export const keep = true;\n");
  const opened = await s.open(false), task = opened.data as any; assert.equal(opened.outcome, "ok", JSON.stringify(opened));
  assert.equal(((await s.write()).hookSpecificOutput as any)?.permissionDecision, "deny", "不能擅自代用户选来源");
  assert.notEqual(((await s.patch()).hookSpecificOutput as any)?.permissionDecision, "deny");
  const update = await s.call("task_update", { task_id: task.id, expected_revision: 0, implementation_basis: s.request.implementation_basis });
  assert.equal(update.outcome, "ok", JSON.stringify(update));
  assert.equal((await s.call("task_update", { task_id: task.id, expected_revision: 1, change_items: [...task.change_items, { ...task.change_items[0], id: "unrelated", target_path: "src/auth.js" }] })).code, "MERGE_RECOVERY_SCOPE");
  assert.notEqual(((await s.write("git add -- pnpm-lock.yaml")).hookSpecificOutput as any)?.permissionDecision, "deny");
  s.git(["add", "--", "pnpm-lock.yaml"]);
  assert.equal((await s.call("task_check", { task_id: task.id })).code, "MERGE_MARKERS_REMAIN");
  assert.equal((await s.call("task_update", { task_id: task.id, expected_revision: 1, phase: "closed" })).code, "MERGE_MARKERS_REMAIN");
  await writeFile(join(s.fixture.path, "pnpm-lock.yaml"), "lockfileVersion: manually-merged\n");
  assert.equal((await s.call("task_check", { task_id: task.id })).code, "MERGE_RECOVERY_NOT_STAGED", "工作副本已清markers但index仍有旧冲突内容，不能验收");
  s.git(["add", "--", "pnpm-lock.yaml"]);
  assert.ok(((await s.call("task_check", { task_id: task.id })).data as any)?.review_snapshot);
  assert.equal(await readFile(join(s.fixture.path, "preexisting.js"), "utf8"), "export const keep = true;\n");
  await writeFile(join(s.fixture.path, "unexpected.js"), "export const unrelated = true;\n");
  const denied = await s.patch(); assert.equal((denied.hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.match((denied.hookSpecificOutput as any).permissionDecisionReason, /范围外/);
});

test("新增冲突或替换index stages不能扩大已捕获恢复授权，非merge场景不冒用恢复入口", async t => {
  const s = await setup(t), opened = await s.open(false), task = opened.data as any; assert.equal(opened.outcome, "ok");
  const raw = s.git(["ls-files", "--unmerged"]);
  execFileSync("git", ["update-index", "--index-info"], { cwd: s.fixture.path, input: `0 ${"0".repeat(40)}\tREADME.md\n` + raw.replaceAll("pnpm-lock.yaml", "README.md") + "\n" });
  assert.equal((await s.call("task_check", { task_id: task.id })).code, "MERGE_RECOVERY_CHANGED");
  assert.equal(((await s.patch()).hookSpecificOutput as any)?.permissionDecision, "deny");
  await s.call("task_update", { task_id: task.id, expected_revision: 0, phase: "aborted", abort_reason: "外部操作新增冲突，重新确认范围" });
  s.git(["restore", "--source=HEAD", "--staged", "--worktree", "--", "README.md"]);
  s.git(["merge", "--abort"]); s.session.turn_id = "clean-turn";
  assert.equal((await s.open()).code, "MERGE_RECOVERY_NOT_REQUIRED");
});

test("来源引用移动不能悄悄换源，固定提交仍可用；merge完成后保留基线并只允许验证审查", async t => {
  const s = await setup(t), opened = await s.open(), task = opened.data as any; assert.equal(opened.outcome, "ok");
  const recovery = task.workspace_baseline.merge_recovery;
  s.git(["update-ref", "refs/remotes/origin/fix/runtime-compatibility-baseline", "incoming"]);
  assert.equal(((await s.write()).hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.notEqual(((await s.write(restore.replace("origin/fix/runtime-compatibility-baseline", recovery.source.commit))).hookSpecificOutput as any)?.permissionDecision, "deny");
  await writeFile(join(s.fixture.path, "pnpm-lock.yaml"), "lockfileVersion: wrong-source\n"); s.git(["add", "--", "pnpm-lock.yaml"]);
  assert.equal((await s.call("task_check", { task_id: task.id })).code, "MERGE_RECOVERY_SOURCE_MISMATCH");
  s.git(["restore", `--source=${recovery.source.commit}`, "--staged", "--worktree", "--", "pnpm-lock.yaml"]);
  s.git(["commit", "-m", "merge resolved by user"]);
  const checked = await s.call("task_check", { task_id: task.id });
  assert.equal((checked.data as any).merge_recovery.state, "committed", JSON.stringify(checked));
  assert.equal((checked.data as any).baseline_head, task.baseline_head);
  assert.equal(((await s.patch()).hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.notEqual(((await s.write(`node /installed/project-dev-agent/runtime/cli.mjs validation run --project '${s.fixture.path}' --task-id ${task.id} --check-id project-tests`)).hookSpecificOutput as any)?.permissionDecision, "deny");
});

test("本分支已有任务不被接管：原会话显式挂起后能开恢复任务；abort或新merge不沿用旧授权", async t => {
  const s = await setup(t, true), previous = s.taskBeforeMerge;
  const blocked = await s.open(); assert.equal(blocked.code, "ACTIVE_TASK_EXISTS", JSON.stringify(blocked));
  assert.deepEqual(await new TaskStore(s.fixture.path).load(previous.id), previous);
  assert.equal((await s.call("task_update", { task_id: previous.id, expected_revision: 0, phase: "suspended", suspend_reason: "用户要求先解决当前merge冲突，保留原任务后续继续" })).code, "TASK_SUSPENDED");
  const opened = await s.open(), task = opened.data as any; assert.equal(opened.outcome, "ok", JSON.stringify(opened));
  assert.equal((await new TaskStore(s.fixture.path).load(previous.id)).phase, "suspended");
  s.git(["merge", "--abort"]);
  const checked = await s.call("task_check", { task_id: task.id }); assert.equal(checked.code, "MERGE_RECOVERY_CHANGED");
  assert.equal(((await s.patch()).hookSpecificOutput as any)?.permissionDecision, "deny");
  assert.equal((await s.call("task_update", { task_id: task.id, expected_revision: 0, phase: "aborted", abort_reason: "用户撤销merge，保留恢复记录" })).outcome, "ok");
  assert.equal((await s.call("task_update", { task_id: previous.id, expected_revision: 1, phase: "active" })).code, "TASK_RESUMED");
});
