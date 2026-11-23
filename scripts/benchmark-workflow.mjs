import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 分别指向已构建的基线和候选工作副本。每次使用独立的临时 Git 仓库及 Codex 设置。
const [directory, mode] = process.argv.slice(2);
if (!directory || !["baseline", "candidate"].includes(mode)) {
  throw new Error("用法：node scripts/benchmark-workflow.mjs <已构建的工作副本> baseline|candidate");
}
const load = name => import(pathToFileURL(join(resolve(directory), "dist", name)).href);
const home = await mkdtemp(join(tmpdir(), "pda-benchmark-"));
process.env.CODEX_HOME = home;

async function measure(count, operation) {
  const times = [], sizes = [];
  // 一次预热后记录中位数；统计服务结果序列化大小，不包含模型生成和网络时间。
  await operation(0);
  for (let index = 1; index <= count; index++) {
    const start = performance.now();
    const result = await operation(index);
    times.push(performance.now() - start);
    assert.notEqual(result.outcome, "error", JSON.stringify(result.diagnostics));
    sizes.push(Buffer.byteLength(JSON.stringify(result)));
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(count / 2)];
  return { samples: count, median_ms: Number(median(times).toFixed(2)), median_bytes: median(sizes) };
}

let fixture;
try {
  const [{ createGitFixture }, { withImplementationBasis }, { PluginSettings }, { RuntimeSettings }, { handleHook }, { TaskService }, { UnderstandingService }, { bindWorktree }] =
    await Promise.all(["tests/helpers/create-git-fixture.js", "tests/helpers/implementation-basis.js", "src/plugin-settings.js",
      "src/runtime/config.js", "src/hooks/handler.js", "src/task-service.js", "src/understanding/service.js", "src/git/index.js"].map(load));
  await new RuntimeSettings(home).configure({ apply: true, expected_revision: null, mode: "auto", diagnostics: { local: false, upload: false } });
  fixture = await createGitFixture();
  const project = fixture.path, binding = await bindWorktree(project);
  const tasks = new TaskService(binding), index = new UnderstandingService(binding);
  await new PluginSettings(home).prepare(project, { apply: true });
  await index.scan({});
  const task = await tasks.open(await withImplementationBasis(project, {
    requirement: "沿用已有实现修改账户状态", acceptance_criteria: [{ id: "account", description: "按现有规则检查账户状态" }],
  }));
  assert.equal(task.outcome, "ok");
  const fields = { task_id: task.data.id };
  const hook = (event, extra) => handleHook({ hook_event_name: event, cwd: project, session_id: "performance", ...extra }, directory, home);
  await hook("SessionStart", {});
  const candidate = mode === "candidate";
  const ordinary = await measure(7, i => hook("UserPromptSubmit", { turn_id: String(i), prompt: "解释一下已有代码" }));
  const scan = await measure(5, () => index.scan({}));
  const context = await measure(5, () => index.context({ query: "account", paths: ["src/auth.js"], ...(candidate ? { view: "compact" } : {}) }));
  await appendFile(join(project, "src/auth.js"), "\n// 同一项账户变更的对照样本。\n");
  const resume = await measure(7, async () => {
    const result = await tasks.check({ ...fields, ...(candidate ? { mode: "resume" } : {}) });
    if (candidate) assert.equal(result.code, "TASK_CONTINUATION_READY");
    return result;
  });
  const review = await measure(3, async () => {
    const result = await tasks.check(fields);
    assert.ok(result.data.review_snapshot);
    return result;
  });
  console.log(JSON.stringify({ mode, ordinary, scan, context, resume, review }, null, 2));
} finally {
  await fixture?.cleanup();
  await rm(home, { recursive: true, force: true });
}
