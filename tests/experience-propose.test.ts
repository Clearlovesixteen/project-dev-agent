import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { TaskSchema } from "../src/domain/task.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { reviewKnowledge } from "../src/knowledge/review.js";
import { parseKnowledge, renderKnowledge } from "../src/knowledge/document.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { TaskService } from "../src/task-service.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("a specific correction becomes a local draft, requires review, then is reusable on a later task", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const tasks = new TaskService(binding);
  const knowledge = new KnowledgeService(binding);
  const task = TaskSchema.parse((await tasks.open({ requirement: "Adjust account eligibility", acceptance_criteria: [{ id: "sessions", description: "Review existing sessions" }] })).data);
  const proposal = { task_id: task.id, correction_id: "existing-sessions", title: "同步考虑旧会话", type: "change_relation", modules: ["accounts"],
    paths: ["src"], applicable_conditions: ["修改账号可用状态"], rule: "修改账号状态时，同时核对新登录和已有会话。", review_questions: ["是否适用于所有限制访问的状态？"] };
  assert.equal((await knowledge.propose(proposal)).code, "CORRECTION_NOT_FOUND");
  assert.equal((await tasks.update({ task_id: task.id, expected_revision: 0, corrections: [{ id: "existing-sessions", description: "Only new logins were considered",
    rationale: "The policy also requires immediate loss of existing session access", sources: [{ kind: "document", reference: "docs/account-policy.md" }] }] })).outcome, "ok");
  const proposed = await knowledge.propose(proposal);
  assert.equal(proposed.outcome, "ok");
  const { file } = proposed.data as { file: string };
  const before = parseKnowledge(await readFile(join(fixture.path, file), "utf8"));
  assert.equal(before.status, "candidate");
  assert.ok(before.sources.some((source) => source.reference === `task:${task.id}#existing-sessions`));
  await assert.rejects(reviewKnowledge(fixture.path, file, "fixture-reviewer"), { code: "REVIEW_QUESTIONS_OPEN" });
  const empty = (await knowledge.search({ query: "同步考虑旧会话" })).data as { results: { id: string }[] };
  assert.ok(!empty.results.some((entry) => entry.id === before.id));

  // Simulate a colleague editing the draft and explicitly accepting it in this test only.
  await writeFile(join(fixture.path, file), renderKnowledge({ ...before, review_questions: [] }));
  const files = new ProjectFiles(binding.root);
  try { await files.create(".project-dev/project.yaml", "schema_version: 1\nmodules:\n  - name: accounts\n    paths: [src]\n"); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "FILE_EXISTS")) throw error;
  }
  const reviewed = await reviewKnowledge(fixture.path, file, "fixture-reviewer");
  assert.equal(reviewed.status, "confirmed");
  assert.equal(parseKnowledge(await files.read(file)).status, "candidate");
  assert.equal((await tasks.update({ task_id: task.id, expected_revision: 1, phase: "aborted", abort_reason: "End correction recording fixture" })).outcome, "ok");
  execFileSync("git", ["add", ".project-dev"], { cwd: fixture.path });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Review fixture experience"], { cwd: fixture.path, stdio: "pipe" });
  const second = TaskSchema.parse((await tasks.open({ requirement: "Another eligibility change", acceptance_criteria: [{ id: "reuse", description: "Review sessions using the confirmed rule" }] })).data);
  const found = (await knowledge.search({ modules: ["accounts"], paths: ["src/auth.js"] })).data as { results: { id: string; version: string }[] };
  const reused = found.results.find((entry) => entry.id === before.id);
  assert.ok(reused);
  assert.equal((await tasks.update({ task_id: second.id, expected_revision: 0, knowledge_versions: [{ id: reused.id, version: reused.version }] })).outcome, "ok");
  assert.equal((await tasks.update({ task_id: second.id, expected_revision: 1, knowledge_versions: [{ id: reused.id, version: "a".repeat(64) }] })).code, "KNOWLEDGE_VERSION_UNKNOWN");
  assert.equal((await tasks.update({ task_id: second.id, expected_revision: 1, knowledge_versions: [] })).code, "RECORD_REMOVAL_NOT_ALLOWED");
  await assert.rejects(reviewKnowledge(fixture.path, file, "fixture-reviewer"), { code: "KNOWLEDGE_ID_EXISTS" });
});
