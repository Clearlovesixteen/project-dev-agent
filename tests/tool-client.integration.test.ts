import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGitFixture } from "./helpers/create-git-fixture.js";
const exec = promisify(execFile),
  cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
test("正式终端通道经真实STDIO调用同一工具，区分独立启动与宿主工具可见性", async (t) => {
  const f = await createGitFixture();
  t.after(f.cleanup);
  // 独立进程会移除 NODE_TEST_CONTEXT，仍须显式隔离 HOME，避免合成测试写入维护者的真实诊断。
  const home = join(f.root, "isolated-codex");
  await mkdir(home);
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.NODE_TEST_CONTEXT;
  const preflight = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "tools", "preflight", "--workspace", f.root],
        { env },
      )
    ).stdout,
  );
  assert.equal(preflight.data.stdio_connected, true);
  assert.equal(preflight.data.host_tool_visibility, "not_checked");
  assert.ok(preflight.data.tools.includes("project_feedback_record"));
  const input = join(f.root, "input.json");
  await writeFile(input, JSON.stringify({}));
  const result = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "tools",
          "call",
          "--workspace",
          f.root,
          "--project",
          f.path,
          "--tool",
          "task_check",
          "--file",
          input,
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(result.code, "NO_ACTIVE_TASK");
  await assert.rejects(
    exec(
      process.execPath,
      [
        cli,
        "tools",
        "call",
        "--workspace",
        f.path,
        "--project",
        f.root,
        "--tool",
        "task_check",
        "--file",
        input,
      ],
      { env },
    ),
    (e: any) => JSON.parse(e.stdout).code === "PROJECT_OUTSIDE_WORKSPACE",
  );
});
test("正式通道默认保留个人插件范围，未配置不会悄悄切换单仓库服务", async (t) => {
  const f = await createGitFixture();
  t.after(f.cleanup);
  const home = join(f.root, "empty-codex");
  await mkdir(home);
  const input = join(f.root, "input.json");
  await writeFile(input, "{}");
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(
    exec(
      process.execPath,
      [
        cli,
        "tools",
        "call",
        "--project",
        f.path,
        "--tool",
        "task_check",
        "--file",
        input,
      ],
      { env },
    ),
    (e: any) => JSON.parse(e.stdout).code === "PLUGIN_NOT_CONFIGURED",
  );
});
