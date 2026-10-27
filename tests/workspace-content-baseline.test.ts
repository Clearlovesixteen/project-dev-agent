import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, unlink, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { TaskService } from "../src/task-service.js";
import { bindWorktree } from "../src/git/index.js";
import { TaskSchema } from "../src/domain/task.js";
import { baselineContent } from "../src/git/workspace-baseline.js";
import { reviewSnapshot } from "../src/git/review-snapshot.js";
import {
  recordImplementationBasis,
  implementationBasisReview,
} from "../src/quality/implementation-basis.js";

test("已有暂存、未暂存、新增和删除内容可接入，仅后续增量进入任务且不改变index", async (t) => {
  const f = await createGitFixture();
  t.after(f.cleanup);
  const binding = await bindWorktree(f.path),
    service = new TaskService(binding);
  const original = await readFile(join(f.path, "src/service.js"), "utf8");
  await writeFile(
    join(f.path, "src/service.js"),
    original + "\n// 用户已有修改\n",
  );
  execFileSync("git", ["add", "src/service.js"], { cwd: f.path });
  await writeFile(
    join(f.path, "src/service.js"),
    original + "\n// 用户已有暂存后续改动\n",
  );
  await writeFile(join(f.path, "existing.js"), "export const user=1;\n");
  await unlink(join(f.path, "src/view.js"));
  const status = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: f.path,
    encoding: "utf8",
  });
  const task = TaskSchema.parse(
    (
      await service.open(
        await withImplementationBasis(f.path, {
          requirement: "在已有工作上继续需求",
          acceptance_criteria: [{ id: "a", description: "保留用户工作" }],
        }),
      )
    ).data,
  );
  assert.equal(task.implementation_bases![0]!.timing, "before_changes");
  assert.deepEqual(
    (await service.check({})).data &&
      ((await service.check({})).data as any).changed_paths,
    [],
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: f.path,
      encoding: "utf8",
    }),
    status,
  );
  assert.equal(
    await baselineContent(
      binding,
      task.baseline_head,
      "existing.js",
      task.workspace_baseline,
    ),
    "export const user=1;\n",
  );
  await writeFile(
    join(f.path, "src/service.js"),
    original + "\n// 用户已有暂存后续改动\n// 本轮实现\n",
  );
  await unlink(join(f.path, "existing.js"));
  await writeFile(join(f.path, "src/view.js"), "// 恢复既有删除\n");
  assert.deepEqual(
    (await reviewSnapshot(binding, task.baseline_head, task.workspace_baseline))
      .paths,
    ["existing.js", "src/service.js", "src/view.js"],
  );
  assert.equal(
    (
      await service.update({
        task_id: task.id,
        expected_revision: 0,
        corrections: [
          {
            id: "note",
            description: "继续保留原有工作",
            rationale: "用户已有改动",
            sources: [{ kind: "experience", reference: "fixture" }],
          },
        ],
      })
    ).outcome,
    "ok",
  );
});
test("接入前已有新文件重命名、二进制与链接保留来源，恢复HEAD也属于后续增量", async (t) => {
  const f = await createGitFixture();
  t.after(f.cleanup);
  const b = await bindWorktree(f.path),
    s = new TaskService(b);
  await rename(join(f.path, "src/view.js"), join(f.path, "src/new-view.js"));
  await writeFile(join(f.path, "binary.bin"), Buffer.from([0, 255, 1]));
  await symlink("/outside/not-read", join(f.path, "link"));
  const task = TaskSchema.parse(
    (
      await s.open(
        await withImplementationBasis(f.path, {
          requirement: "增量识别",
          acceptance_criteria: [{ id: "a", description: "区分旧修改" }],
        }),
      )
    ).data,
  );
  assert.deepEqual(
    (await reviewSnapshot(b, task.baseline_head, task.workspace_baseline))
      .paths,
    [],
  );
  const text = execFileSync(
    "git",
    ["show", `${task.baseline_head}:src/view.js`],
    { cwd: f.path, encoding: "utf8" },
  );
  await writeFile(join(f.path, "src/view.js"), text);
  assert.deepEqual(
    (await reviewSnapshot(b, task.baseline_head, task.workspace_baseline))
      .paths,
    ["src/view.js"],
  );
});
test("初始未提交的规范修改可以作为真实原文依据，随后变化仍从接入内容核对", async (t) => {
  const f = await createGitFixture();
  t.after(f.cleanup);
  const b = await bindWorktree(f.path),
    s = new TaskService(b),
    path = join(f.path, "AGENTS.md");
  await writeFile(path, "本次沿用项目既有规范，保留用户已有内容。\n");
  const input = await withImplementationBasis(f.path, {
    requirement: "遵循现有规范",
    acceptance_criteria: [{ id: "a", description: "依据可核对" }],
  });
  const task = TaskSchema.parse((await s.open(input)).data);
  await writeFile(path, "本轮继续调整规范。\n");
  assert.equal(
    (await implementationBasisReview(b, task, "a".repeat(64))).references[0]!
      .state,
    "task_baseline",
  );
  const late = await recordImplementationBasis(
    b,
    task.baseline_head,
    input.implementation_basis,
    ["a"],
    task.workspace_baseline,
  ).catch(() => undefined);
  assert.equal(late, undefined);
});
