import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readlink, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectKnowledgeRepository } from "../src/project-knowledge/repository.js";
import { RepositoryFiles } from "../src/project-knowledge/repository-files.js";
import { readProjectKnowledgeLight } from "../src/project-knowledge/service.js";

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

test("openExisting 是只读探测，知识库结构不完整时不会偷偷创建目录", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = await RepositoryFiles.open(binding.repo_identity);
  await rm(join(files.root, "objects"), { recursive: true, force: true });
  await assert.rejects(RepositoryFiles.openExisting(binding.repo_identity), /缺少目录：objects/);
  assert.deepEqual((await readdir(files.root)).sort(), ["migrations", "operations", "transactions"].sort());
});

test("需求组先初始化时，知识库探测不会把协调目录误判为损坏", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await mkdir(join(binding.repo_identity, "project-dev-agent", "requirement-groups"), { recursive: true });
  assert.equal(await RepositoryFiles.openExisting(binding.repo_identity), undefined);
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
  const index = JSON.parse(await repository.files.read("CURRENT_INDEX.json")) as { transaction_id: string; object_ids: string[]; object_ids_hash: string };
  assert.equal(index.transaction_id, (await repository.current())?.transaction_id);
  assert.deepEqual(new Set(index.object_ids), new Set([a.object_id, b.object_id]));
  assert.equal(index.object_ids_hash.length, 64);
  await assert.rejects(repository.publish({ operation_id: "operation-a", objects: [b] }), /operation_id 已用于另一组/);
});

test("轻量知识状态按当前索引统计全部对象而非只统计最后事务", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  await repository.publish({ operation_id: "light-a", objects: [object("A")] });
  await repository.publish({ operation_id: "light-b", objects: [object("B")] });
  const status = await readProjectKnowledgeLight(binding);
  assert.equal(status.state, "unverified");
  assert.equal(status.snapshot_count, 2);
});

test("物化对象索引缺失或损坏时安全回退事务链", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const a = object("index-fallback"); await repository.publish({ operation_id: "index-fallback", objects: [a] });
  await repository.files.replace("CURRENT_INDEX.json", JSON.stringify({ schema_version: 1, transaction_id: "f".repeat(64), object_ids: [], object_ids_hash: "0".repeat(64), updated_at: new Date().toISOString() }), await repository.files.read("CURRENT_INDEX.json"));
  assert.deepEqual(await repository.currentObjectIds(), [a.object_id]);
});

test("读取共享对象会校验内容哈希，损坏快照不会被当作最新知识", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const a = object("A"); await repository.publish({ operation_id: "operation-a", objects: [a] });
  await repository.files.replace(`objects/${a.object_id}.json`, JSON.stringify({ ...a, content: { value: "tampered" } }), JSON.stringify(a));
  await assert.rejects(repository.readObject(a.object_id), /对象内容哈希不匹配/);
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

test("operation marker recovery repairs CURRENT after a crash before the first pointer write", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const a = object("A");
  const originalCreate = repository.files.create.bind(repository.files);
  let failCurrent = true;
  (repository.files as unknown as { create: typeof repository.files.create }).create = async (path, content, maximum) => {
    if (path === "CURRENT.json" && failCurrent) { failCurrent = false; throw new Error("simulated crash before CURRENT"); }
    return originalCreate(path, content, maximum);
  };
  await assert.rejects(repository.publish({ operation_id: "operation-a", objects: [a] }), /simulated crash/);
  assert.equal(await repository.current(), undefined);
  const recovered = await repository.publish({ operation_id: "operation-a", objects: [a] });
  assert.equal((await repository.current())?.transaction_id, recovered.transaction.transaction_id);
  assert.deepEqual(new Set(await repository.currentObjectIds()), new Set([a.object_id]));
});

test("operation marker recovery appends after another worktree committed meanwhile", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), repository = await ProjectKnowledgeRepository.open(binding.repo_identity);
  const a = object("A"), b = object("B");
  const originalCreate = repository.files.create.bind(repository.files);
  let failCurrent = true;
  (repository.files as unknown as { create: typeof repository.files.create }).create = async (path, content, maximum) => {
    if (path === "CURRENT.json" && failCurrent) { failCurrent = false; throw new Error("simulated crash before CURRENT"); }
    return originalCreate(path, content, maximum);
  };
  await assert.rejects(repository.publish({ operation_id: "operation-a", objects: [a] }), /simulated crash/);
  const bResult = await repository.publish({ operation_id: "operation-b", objects: [b] });
  const recovered = await repository.publish({ operation_id: "operation-a", objects: [a] });
  assert.equal(recovered.transaction.parent_transaction_id, bResult.transaction.transaction_id);
  assert.deepEqual(new Set(await repository.currentObjectIds()), new Set([a.object_id, b.object_id]));
});
