import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceContent } from "../src/git/workspace-content.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { compactTaskReceipt } from "../src/tools/task-receipt.js";

test("快照复用后仍检测同长度改写、路径替换和删除，完整基线保存原字节", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pda-digest-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "changed.bin"), files = new ProjectFiles(directory);
  const source = Buffer.concat([Buffer.alloc(65536, 1), Buffer.alloc(65536, 2), Buffer.from([3])]);
  await writeFile(path, source);
  const original = await stat(path);
  // 稳定时间超过缓存保护窗口，重复查询可以走读取摘要的分支。
  await new Promise(resolve => setTimeout(resolve, 1050));
  const snapshot = () => workspaceContent(files, "changed.bin");
  const first = (await snapshot()).entry;
  assert.equal(first.sha256, createHash("sha256").update(source).digest("hex"));
  assert.deepEqual((await snapshot()).entry, first);
  assert.deepEqual((await workspaceContent(files, "changed.bin", true)).content, source);
  source[0] = 5;
  await writeFile(path, source);
  await utimes(path, original.atime, original.mtime);
  const changed = (await snapshot()).entry;
  assert.notEqual(changed.sha256, first.sha256);
  source[0] = 7;
  await writeFile(join(directory, "replacement"), source);
  await rename(join(directory, "replacement"), path);
  assert.equal((await snapshot()).entry.sha256, createHash("sha256").update(await readFile(path)).digest("hex"));
  await rm(path);
  assert.equal((await snapshot()).entry.kind, "missing");
});

test("紧凑任务回执保留修订号和告警，失败原样返回", () => {
  const diagnostics = [{ code: "REQUIREMENT_SCOPE_OVERLAP_REVIEW", message: "集成前复核" }];
  const result = { outcome: "ok" as const, code: "TASK_UPDATED", diagnostics,
    data: { id: "one", revision: 7, phase: "active", change_items: [{ rationale: "x".repeat(3000) }] } };
  const compact = compactTaskReceipt(result);
  assert.equal((compact.data as { revision: number }).revision, 7);
  assert.equal(compact.diagnostics, diagnostics);
  assert.ok(JSON.stringify(compact).length < 500);
  assert.equal(result.data.change_items[0]!.rationale.length, 3000);
  const error = { outcome: "error" as const, code: "TASK_NOT_FOUND", diagnostics };
  assert.equal(compactTaskReceipt(error), error);
});
