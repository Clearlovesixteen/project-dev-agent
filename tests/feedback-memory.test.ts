import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { recordFeedback, feedbackContext } from "../src/feedback/service.js";
import { feedbackReview } from "../src/feedback/review.js";
import { TaskService } from "../src/task-service.js";
import { TaskSchema } from "../src/domain/task.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { HistoryService } from "../src/history/service.js";
import { historyFreshness } from "../src/history/freshness.js";
const message = (id: string, role: string, text: string) =>
  JSON.stringify({
    timestamp: "2026-10-27T00:00:00Z",
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  }) + "\n";
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const f = await createGitFixture();
  t.after(f.cleanup);
  const binding = await bindWorktree(f.path),
    home = join(f.root, "codex");
  await mkdir(join(home, "sessions"), { recursive: true });
  const log = join(home, "sessions", "main.jsonl");
  await writeFile(
    log,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "main", cwd: binding.root, source: "vscode" },
    }) +
      "\n" +
      message("u1", "user", "接口必须复用项目现有请求封装。") +
      message("a1", "assistant", "所有页面都应该重新封装客户端。"),
  );
  const input = {
    id: "native-request",
    rule: "接口复用现有请求入口",
    category: "code_convention",
    audience: "project",
    paths: ["src/**"],
    conditions: ["当前项目已有适用请求入口"],
    source: { session_id: "main", quote: "接口必须复用项目现有请求封装。" },
  };
  return {
    f,
    binding,
    home,
    log,
    input,
    files: new ProjectFiles(binding.root),
  };
}
test("没有活跃任务也可立即保存纠正，重启查询返回原话及适用范围，不自动确认规则", async (t) => {
  const s = await setup(t);
  const record = await recordFeedback(s.binding, s.input, s.home);
  assert.equal(record.source.session, "main");
  assert.deepEqual(await recordFeedback(s.binding, s.input, s.home), record);
  const found = await feedbackContext(
    new ProjectFiles(s.binding.root),
    "请求",
    ["src/new-module/api.js"],
  );
  assert.equal(found.items[0]!.effective, false);
  assert.equal(found.items[0]!.source.quote, s.input.source.quote);
  assert.equal(
    (await feedbackContext(s.files, "请求", ["other/api.js"])).items.length,
    0,
  );
  const search = (
    await new KnowledgeService(s.binding).search({
      query: "请求",
      paths: ["src/new-module/api.js"],
    })
  ).data as any;
  assert.equal(search.feedback.items[0].input.id, s.input.id);
});
test("助手建议、伪造原话及其他项目不能进入即时纠正，修订和停用保留原记录", async (t) => {
  const s = await setup(t);
  await assert.rejects(
    recordFeedback(
      s.binding,
      {
        ...s.input,
        source: { session_id: "main", quote: "所有页面都应该重新封装客户端。" },
      },
      s.home,
    ),
    { code: "FEEDBACK_SOURCE_INVALID" },
  );
  await recordFeedback(s.binding, s.input, s.home);
  await assert.rejects(
    recordFeedback(s.binding, { ...s.input, rule: "覆盖原规则" }, s.home),
    { code: "FEEDBACK_IMMUTABLE" },
  );
  await appendFile(
    s.log,
    message("u2", "user", "停用原来的请求约定，保留历史。"),
  );
  await recordFeedback(
    s.binding,
    {
      ...s.input,
      id: "disable-native",
      status: "disabled",
      supersedes_id: s.input.id,
      source: { session_id: "main", quote: "停用原来的请求约定，保留历史。" },
    },
    s.home,
  );
  assert.equal((await feedbackContext(s.files)).items.length, 0);
  assert.ok(
    await readFile(
      join(s.binding.root, ".project-dev/local/feedback/native-request.json"),
      "utf8",
    ),
  );
});
test("新纠正使旧任务反馈版本失效，读取并关联验收后仍须实际复核", async (t) => {
  const s = await setup(t),
    service = new TaskService(s.binding);
  const task = TaskSchema.parse(
    (
      await service.open(
        await withImplementationBasis(s.binding.root, {
          requirement: "沿用现有请求开发模块",
          acceptance_criteria: [{ id: "reuse", description: "复用已有能力" }],
        }),
      )
    ).data,
  );
  await recordFeedback(s.binding, s.input, s.home);
  assert.equal(
    (await feedbackReview(s.binding, task, "a".repeat(64))).state,
    "stale",
  );
  const context = await feedbackContext(
    s.files,
    task.requirement,
    task.scope_paths,
  );
  const result = await service.update({
    task_id: task.id,
    expected_revision: 0,
    feedback_review: {
      version: context.version,
      decisions: [
        {
          id: s.input.id,
          disposition: "apply",
          reason: "本次接口开发使用现有请求入口并核对调用方式",
          acceptance_ids: ["reuse"],
        },
      ],
    },
  });
  assert.equal(result.outcome, "ok");
  assert.equal(
    (
      await feedbackReview(
        s.binding,
        TaskSchema.parse(result.data),
        "a".repeat(64),
      )
    ).state,
    "pending",
  );
});
test("同一长会话追加和跨日恢复能发现新历史，重扫不把未分析消息算成完成", async (t) => {
  const s = await setup(t),
    history = new HistoryService(s.binding, s.home);
  await history.scan({});
  assert.equal((await historyFreshness(s.files, s.home)).state, "current");
  const old = (await history.next({})).data as any;
  await history.record({
    scan_id: old.scan_id,
    batch_id: old.batch.id,
    findings: [],
    note: "已核对原批次",
  });
  await appendFile(
    s.log,
    message("u3", "user", "布局仍需要沿用原来的列表组件。"),
  );
  assert.equal((await historyFreshness(s.files, s.home)).needs_refresh, true);
  await history.scan({});
  const next = (await history.next({})).data as any;
  assert.equal(next.analysis_complete, false);
  assert.ok(
    next.batch.messages.some((m: any) => m.text.includes("布局仍需要")),
  );
});

test("旧任务不读取新反馈资料，初始纠正选择拒绝未知ID", async (t) => {
  const s = await setup(t),
    service = new TaskService(s.binding);
  const request = await withImplementationBasis(s.binding.root, {
    requirement: "旧任务兼容",
    acceptance_criteria: [{ id: "a", description: "保持原契约" }],
  });
  const context = await feedbackContext(s.files);
  assert.equal(
    (
      await service.open({
        ...request,
        feedback_review: {
          version: context.version,
          decisions: [
            {
              id: "invented",
              disposition: "not_applicable",
              reason: "此条并不是当前项目已有的纠正",
              acceptance_ids: [],
            },
          ],
        },
      })
    ).code,
    "FEEDBACK_REVIEW_INVALID",
  );
  const task = TaskSchema.parse((await service.open(request)).data);
  delete task.feedback_policy;
  await s.files.directory(".project-dev/local/feedback");
  await s.files.create(
    ".project-dev/local/feedback/broken.json",
    "broken data",
  );
  assert.equal(
    (await feedbackReview(s.binding, task, "a".repeat(64))).state,
    "legacy",
  );
});
