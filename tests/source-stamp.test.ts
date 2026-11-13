import assert from "node:assert/strict";
import { appendFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { bindWorktree } from "../src/git/index.js";
import { collectSourceStamp } from "../src/project-knowledge/source-stamp.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("same HEAD with different dirty content receives different source stamps", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), first = await collectSourceStamp(binding);
  await appendFile(`${fixture.path}/src/index.ts`, "\n// dirty one\n");
  const second = await collectSourceStamp(binding);
  assert.equal(first.head, second.head);
  assert.notEqual(first.stamp_id, second.stamp_id);
  assert.ok(second.entries.some((entry) => entry.path === "src/index.ts" && entry.kind === "file"));
});

test("new, deleted, untracked and renamed paths are included without reading excluded directories", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await writeFile(`${fixture.path}/new-local.txt`, "new");
  await rm(`${fixture.path}/src/system.js`);
  const stamp = await collectSourceStamp(binding);
  assert.equal(stamp.entries.find((entry) => entry.path === "new-local.txt")?.kind, "file");
  assert.equal(stamp.entries.find((entry) => entry.path === "src/system.js")?.kind, "missing");
  assert.equal(stamp.entries.some((entry) => entry.path.split("/").includes("node_modules") || entry.path.split("/").includes(".git")), false);
  assert.ok(stamp.status.untracked >= 1 && stamp.status.deleted >= 1);
});

test("unchanged capture is stable and records configuration fingerprints", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), first = await collectSourceStamp(binding), second = await collectSourceStamp(binding);
  assert.equal(first.stamp_id, second.stamp_id);
  assert.ok(first.configuration.some((entry) => entry.path.endsWith("package.json")));
});

test("a file changed during analysis returns VIEW_CHANGED", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path);
  await assert.rejects(collectSourceStamp(binding, { onCaptured: () => appendFile(`${fixture.path}/src/index.ts`, "\n// changed while reading\n") }), (error: unknown) => error instanceof Error && "code" in error && error.code === "VIEW_CHANGED");
});
