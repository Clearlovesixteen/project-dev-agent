import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { withHistoryLock } from "../src/history/store.js";
import { locked } from "../src/understanding/store.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

for (const [name, path, busy, lock] of [
  ["历史", ".project-dev/local/history/operation.lock", "HISTORY_BUSY", withHistoryLock],
  ["业务模型", ".project-dev/local/understanding/operation.lock", "PROJECT_MAP_BUSY", locked],
] as const) test(`${name}并发恢复遗留锁时不能删除新持有者的锁`, { timeout: 10_000 }, async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim());
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  await new ProjectFiles(binding.root).create(path, JSON.stringify({ pid: deadPid, token: "abandoned" }));
  let aChecked!: () => void, bReady!: () => void, aActive!: () => void, bDone!: () => void;
  const aRead = new Promise<void>((resolve) => { aChecked = resolve; });
  const bRead = new Promise<void>((resolve) => { bReady = resolve; });
  const aEntered = new Promise<void>((resolve) => { aActive = resolve; });
  const bSettled = new Promise<void>((resolve) => { bDone = resolve; });
  let active = 0, maximum = 0;
  const filesFor = (worker: "a" | "b") => {
    const files = new ProjectFiles(binding.root), read = files.read.bind(files), create = files.create.bind(files);
    let count = 0, attempted = false;
    files.create = async (relative, content) => {
      if (worker === "b" && relative === path && !attempted) { attempted = true; await aRead; }
      return create(relative, content);
    };
    files.read = async (relative, limit) => {
      const value = await read(relative, limit);
      if (relative === path && ++count === 2) {
        // 两次读取后改变调度，重现检查旧锁与删除之间被其他恢复者抢先的情况。
        if (worker === "a") { aChecked(); await Promise.race([bRead, bSettled]); }
        else { bReady(); await aEntered; }
      }
      return value;
    };
    return files;
  };
  const first = lock(filesFor("a"), async () => {
    maximum = Math.max(maximum, ++active); aActive(); await bSettled; active--; return "a";
  });
  const second = lock(filesFor("b"), async () => {
    maximum = Math.max(maximum, ++active); active--; return "b";
  }).then((value) => { bDone(); return value; }, (error: unknown) => { bDone(); throw error; });
  const results = await Promise.allSettled([first, second]);
  assert.equal(maximum, 1, "同一项目只能有一个写入者");
  assert.deepEqual(results[0], { status: "fulfilled", value: "a" });
  assert.equal(results[1]!.status, "rejected");
  if (results[1]!.status === "rejected") assert.equal(results[1]!.reason.code, busy);
});
