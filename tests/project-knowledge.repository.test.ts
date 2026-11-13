import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectKnowledgeRepository } from "../src/project-knowledge/repository.js";
import { RepositoryFiles } from "../src/project-knowledge/repository-files.js";

const object = (value: string) => {
  const content = { value };
  const object_id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { schema_version: 1 as const, object_type: "module_snapshot" as const, object_id, content };
};

test("linked worktrees resolve one project knowledge root while independent repositories do not", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const linked = join(fixture.root, "linked");
  execFileSync("git", ["worktree", "add", "--detach", linked, fixture.head], { cwd: fixture.path });
  t.after(() => rm(linked, { recursive: true, force: true }));
  const first = await bindWorktree(fixture.path), second = await bindWorktree(linked);
  assert.equal(first.repo_identity, second.repo_identity);
  const firstFiles = await RepositoryFiles.open(first.repo_identity), secondFiles = await RepositoryFiles.open(second.repo_identity);
  assert.equal(firstFiles.root, secondFiles.root);
  const firstIdentity = await firstFiles.ensureIdentity(first.repo_identity), secondIdentity = await secondFiles.ensureIdentity(second.repo_identity);
  assert.equal(firstIdentity.project_id, secondIdentity.project_id);

  const other = await createGitFixture(); t.after(other.cleanup);
  const otherBinding = await bindWorktree(other.path), otherFiles = await RepositoryFiles.open(otherBinding.repo_identity);
  const otherIdentity = await otherFiles.ensureIdentity(otherBinding.repo_identity);
  assert.notEqual(otherIdentity.project_id, firstIdentity.project_id);
  assert.notEqual(otherFiles.root, firstFiles.root);
});

test("concurrent first opens tolerate the same project directory race", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const repoIdentity = (await bindWorktree(fixture.path)).repo_identity;
  const identities = await Promise.all(Array.from({ length: 8 }, () => ProjectKnowledgeRepository.open(repoIdentity)));
  assert.equal(new Set(identities.map((item) => item.repo_identity)).size, 1);
  const identity = await identities[0]!.files.readIdentity();
  assert.ok(identity);
});

test("repository files reject a symlinked knowledge root and path traversal", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = await RepositoryFiles.open(binding.repo_identity);
  await assert.rejects(files.path("../outside"));
  const target = await mkdtemp(join(fixture.root, "knowledge-target-")); t.after(() => rm(target, { recursive: true, force: true }));
  await rm(files.root, { recursive: true, force: true });
  await symlink(target, files.root);
  await assert.rejects(RepositoryFiles.open(binding.repo_identity), /符号链接|不安全/);
  assert.equal((await lstat(files.root)).isSymbolicLink(), true);
});

test("immutable objects and CURRENT are committed atomically and same operation is idempotent", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const a = object("A"), first = await repository.publish({ operation_id: "operation-a", objects: [a] });
  const retry = await repository.publish({ operation_id: "operation-a", objects: [a] });
  assert.equal(retry.transaction.transaction_id, first.transaction.transaction_id);
  assert.deepEqual(await repository.current(), first.pointer);
  assert.deepEqual(await repository.readObject(a.object_id), a);
  await assert.rejects(repository.files.create(`objects/${a.object_id}.json`, JSON.stringify({ ...a, content: { value: "changed" } })), /已存在/);
  const b = object("B");
  await repository.publish({ operation_id: "operation-b", objects: [b] });
  const retryAfterAnotherPublish = await repository.publish({ operation_id: "operation-a", objects: [a] });
  assert.equal(retryAfterAnotherPublish.transaction.transaction_id, first.transaction.transaction_id);
  assert.deepEqual(new Set(await repository.currentObjectIds()), new Set([a.object_id, b.object_id]));
  await assert.rejects(repository.publish({ operation_id: "operation-a", objects: [b] }), /operation_id 已用于另一组/);
});

test("concurrent publishers serialize without losing either immutable object", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), first = await ProjectKnowledgeRepository.open(binding.repo_identity), second = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const a = object("A"), b = object("B");
  const results = await Promise.all([
    first.publish({ operation_id: "operation-a", objects: [a] }),
    second.publish({ operation_id: "operation-b", objects: [b] }),
  ]);
  assert.equal(new Set(results.map((result) => result.transaction.transaction_id)).size, 2);
  assert.deepEqual(await first.readObject(a.object_id), a);
  assert.deepEqual(await first.readObject(b.object_id), b);
  const current = await first.current();
  assert.ok(current && [a.object_id, b.object_id].includes(current.object_ids[0]!));
  const transactions = await first.files.read(`transactions/${current!.transaction_id}.json`);
  assert.match(transactions, /operation-[ab]/);
  assert.deepEqual(new Set(await first.currentObjectIds()), new Set([a.object_id, b.object_id]));
});
