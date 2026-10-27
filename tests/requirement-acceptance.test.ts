import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { bindWorktree } from "../src/git/index.js";
import { TaskService } from "../src/task-service.js";
import { TaskSchema } from "../src/domain/task.js";
import {
  requirementReview,
  businessAssessmentReview,
} from "../src/quality/requirement-review.js";
import { runValidation } from "../src/quality/validation-runner.js";
const proof = [
  {
    kind: "manual",
    reference: "prototype",
    summary: "实际核对参考图及当前交互",
  },
];
async function setup(
  t: { after(fn: () => Promise<void>): void },
  sources: any[] = [],
  kind = "technical",
  assessment = true,
) {
  const f = await createGitFixture();
  t.after(f.cleanup);
  const binding = await bindWorktree(f.path),
    service = new TaskService(binding);
  const sourceDir = join(f.path, ".project-dev/local/requirements");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "prd.txt"), "顶部机构切换后清空旧仓选择。\n");
  await writeFile(
    join(sourceDir, "prototype.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const input: any = await withImplementationBasis(f.path, {
    requirement: "按需求和原型修改页面",
    acceptance_criteria: [
      {
        id: "a",
        description: "按指定依据完成验收",
        ...(sources.length || kind !== "technical"
          ? {
              requirement_check: {
                kind,
                source_ids: sources.length
                  ? sources.map((s) => s.id)
                  : ["task-request"],
              },
            }
          : {}),
      },
    ],
  });
  if (!assessment) delete input.business_assessment;
  input.requirement_sources = sources;
  const opened = await service.open(input);
  assert.equal(opened.code, "TASK_OPENED", JSON.stringify(opened));
  const task = TaskSchema.parse(opened.data);
  return { f, binding, service, task };
}
async function mark(service: TaskService, task: any, extra: any = {}) {
  const snapshot = ((await service.check({})).data as any).review_snapshot;
  return service.update({
    task_id: task.id,
    expected_revision: task.revision,
    review_snapshot: snapshot,
    acceptance_criteria: task.acceptance_criteria.map((a: any) => ({
      ...a,
      status: "checked",
      reviewed_by: "fixture",
      evidence: proof,
    })),
    ...extra,
  });
}
test("原型不可读时即使真实测试通过也不能完成视觉验收，明确保留待核验", async (t) => {
  const s = await setup(
    t,
    [
      {
        id: "prototype",
        kind: "unavailable",
        locator: "https://example.invalid/prototype",
        reason: "当前原型无法访问",
      },
    ],
    "visual",
  );
  assert.equal(
    (await runValidation(s.binding, s.task.id, "project-tests")).data.state,
    "passed",
  );
  assert.equal(
    (await mark(s.service, s.task)).code,
    "REQUIREMENT_SOURCE_UNAVAILABLE",
  );
  assert.equal(
    (await requirementReview(s.binding, s.task)).items[0]!.state,
    "source_unavailable",
  );
});
test("需求文字不能冒充视觉参考；可读缓存图片核对后绑定服务端来源版本", async (t) => {
  const s = await setup(t, [], "visual");
  assert.equal((await mark(s.service, s.task)).code, "VISUAL_SOURCE_REQUIRED");
  let result = await s.service.update({
    task_id: s.task.id,
    expected_revision: 0,
    requirement_sources: [
      {
        id: "image",
        kind: "image",
        path: ".project-dev/local/requirements/prototype.png",
      },
    ],
    acceptance_criteria: s.task.acceptance_criteria.map((a) => ({
      ...a,
      status: "pending",
      requirement_check: { kind: "visual", source_ids: ["image"] },
    })),
  });
  assert.equal(result.outcome, "ok");
  result = await mark(s.service, TaskSchema.parse(result.data));
  assert.equal(result.outcome, "ok");
  const task = TaskSchema.parse(result.data);
  assert.ok(
    task.acceptance_criteria[0]!.requirement_versions?.[0]!.fingerprint,
  );
  assert.equal((await requirementReview(s.binding, task)).state, "checked");
  await writeFile(
    join(s.f.path, ".project-dev/local/requirements/prototype.png"),
    "fake image",
  );
  assert.equal((await requirementReview(s.binding, task)).state, "pending");
});
test("PRD变更使已通过验收失效，追加来源修订须重开验收且保留旧版本", async (t) => {
  const s = await setup(
    t,
    [
      {
        id: "prd",
        kind: "document",
        path: ".project-dev/local/requirements/prd.txt",
        quote: "顶部机构切换后清空旧仓选择。",
      },
    ],
    "interaction",
  );
  let marked = await mark(s.service, s.task);
  assert.equal(marked.outcome, "ok");
  let task = TaskSchema.parse(marked.data);
  await writeFile(
    join(s.f.path, ".project-dev/local/requirements/prd.txt"),
    "顶部机构切换后清空旧仓选择，并清除旧详情。\n",
  );
  assert.equal(
    (await requirementReview(s.binding, task)).items[0]!.state,
    "source_unavailable",
  );
  const source = {
    id: "prd",
    kind: "document",
    path: ".project-dev/local/requirements/prd.txt",
    quote: "顶部机构切换后清空旧仓选择，并清除旧详情。",
  };
  assert.equal(
    (
      await s.service.update({
        task_id: task.id,
        expected_revision: task.revision,
        requirement_sources: [source],
      })
    ).code,
    "REQUIREMENT_REVIEW_REQUIRED",
  );
  const reopened = await s.service.update({
    task_id: task.id,
    expected_revision: task.revision,
    requirement_sources: [source],
    acceptance_criteria: task.acceptance_criteria.map((a) => ({
      ...a,
      status: "pending",
    })),
  });
  assert.equal(reopened.outcome, "ok");
  task = TaskSchema.parse(reopened.data);
  assert.equal(
    task.requirement_sources!.filter((x) => x.input.id === "prd").length,
    2,
  );
  marked = await mark(s.service, task);
  assert.equal(marked.outcome, "ok");
  assert.equal(
    (await requirementReview(s.binding, TaskSchema.parse(marked.data))).state,
    "checked",
  );
});
test("业务影响不能缺省为无变化，声明变化须有新版模型与实际草案", async (t) => {
  const s = await setup(t, [], "technical", false);
  assert.equal(
    (await businessAssessmentReview(s.binding, s.task)).state,
    "missing",
  );
  let result = await s.service.update({
    task_id: s.task.id,
    expected_revision: 0,
    business_assessment: {
      state: "changed",
      reason: "本次改变业务行为，应绑定模型和业务变化草案",
      model_ids: [],
      delta_ids: [],
    },
  });
  assert.equal(result.outcome, "ok");
  assert.equal(
    (await businessAssessmentReview(s.binding, TaskSchema.parse(result.data)))
      .state,
    "incomplete",
  );
  result = await s.service.update({
    task_id: s.task.id,
    expected_revision: 1,
    business_assessment: {
      state: "unchanged",
      reason: "核对本次仅调整页面布局，不改变任何业务状态和规则",
      model_ids: [],
      delta_ids: [],
    },
  });
  assert.equal(result.outcome, "ok");
  assert.equal(
    (await businessAssessmentReview(s.binding, TaskSchema.parse(result.data)))
      .state,
    "checked",
  );
});
test("不能以任意文本伪装图片或伪造PRD原文", async (t) => {
  const s = await setup(t);
  await writeFile(
    join(s.f.path, ".project-dev/local/requirements/prototype.png"),
    "some text",
  );
  assert.equal(
    (
      await s.service.update({
        task_id: s.task.id,
        expected_revision: 0,
        requirement_sources: [
          {
            id: "img",
            kind: "image",
            path: ".project-dev/local/requirements/prototype.png",
          },
        ],
      })
    ).code,
    "REQUIREMENT_SOURCE_INVALID",
  );
  assert.equal(
    (
      await s.service.update({
        task_id: s.task.id,
        expected_revision: 0,
        requirement_sources: [
          {
            id: "prd",
            kind: "document",
            path: ".project-dev/local/requirements/prd.txt",
            quote: "文档里没有这句话",
          },
        ],
      })
    ).code,
    "REQUIREMENT_SOURCE_INVALID",
  );
});

test("不能静默降级视觉验收，用户修订后重开并保留前后定义", async (t) => {
  const s = await setup(
    t,
    [
      {
        id: "prototype",
        kind: "unavailable",
        locator: "https://example.invalid/prototype",
        reason: "尚不可读取",
      },
    ],
    "visual",
  );
  const criteria = s.task.acceptance_criteria.map((item) => ({
    ...item,
    requirement_check: { kind: "technical", source_ids: ["task-request"] },
  }));
  assert.equal(
    (
      await s.service.update({
        task_id: s.task.id,
        expected_revision: 0,
        acceptance_criteria: criteria,
      })
    ).code,
    "ACCEPTANCE_REVISION_REQUIRED",
  );
  const result = await s.service.update({
    task_id: s.task.id,
    expected_revision: 0,
    acceptance_criteria: criteria,
    corrections: [
      {
        id: "scope",
        description: "本轮先核对技术接入，视觉另行核验",
        rationale: "记录本次需求范围修订",
        sources: [{ kind: "experience", reference: "fixture-user-request" }],
      },
    ],
    acceptance_revision: {
      reason: "本轮用户调整交付范围，保留原视觉验收定义",
      correction_id: "scope",
    },
  });
  assert.equal(result.outcome, "ok");
  const task = TaskSchema.parse(result.data);
  assert.equal(task.acceptance_revisions?.length, 1);
  assert.equal(task.acceptance_revisions![0]!.before[0]!.check.kind, "visual");
});

test("原始需求来源不可被后续输入覆盖", async (t) => {
  const s = await setup(t);
  const result = await s.service.update({
    task_id: s.task.id,
    expected_revision: 0,
    requirement_sources: [
      {
        id: "task-request",
        kind: "unavailable",
        locator: "替换原始要求",
        reason: "不能覆盖服务捕获的原始来源",
      },
    ],
  });
  assert.equal(result.code, "REQUIREMENT_SOURCE_RESERVED");
});
