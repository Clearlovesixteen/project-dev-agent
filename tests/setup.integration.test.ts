import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, access, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeProject } from "../src/setup.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

test("setup previews without writing, preserves project instructions and is repeatable on a path with spaces", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const original = await readFile(join(fixture.path, "AGENTS.md"), "utf8");
  const preview = await initializeProject(fixture.path, false);
  assert.equal(preview.applied, false);
  await assert.rejects(access(join(fixture.path, ".project-dev")), { code: "ENOENT" });
  const first = await initializeProject(fixture.path, true);
  assert.equal(first.applied, true);
  const instructions = await readFile(join(fixture.path, "AGENTS.md"), "utf8");
  assert.ok(instructions.startsWith(original));
  const second = await initializeProject(fixture.path, true);
  assert.ok(second.changes.every((change) => change.action === "unchanged"));
  assert.equal(await readFile(join(fixture.path, "AGENTS.md"), "utf8"), instructions);
  const config = await readFile(join(fixture.path, ".project-dev/local/codex.toml"), "utf8");
  assert.ok(config.includes(JSON.stringify(fixture.path)));
  const plugin = JSON.parse(await readFile(join(fixture.path, ".project-dev/local/plugin/mcp.json"), "utf8"));
  assert.equal(plugin.mcpServers.project_dev.type, "stdio");
  assert.equal(plugin.mcpServers.project_dev.args.at(-1), fixture.path);
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: fixture.path, encoding: "utf8" });
  assert.ok(!status.includes(".project-dev/local"));
  assert.ok(status.includes(".agents/skills/project-dev/SKILL.md"));
});

test("setup preserves customized files and preflights unsafe paths before changing existing instructions", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  await initializeProject(fixture.path, true);
  const skill = join(fixture.path, ".agents/skills/project-dev/SKILL.md");
  await writeFile(skill, "# Team customized skill\n");
  const again = await initializeProject(fixture.path, true);
  assert.equal(await readFile(skill, "utf8"), "# Team customized skill\n");
  assert.ok(again.warnings.some((message) => message.includes("SKILL.md")));
  const other = await createGitFixture();
  t.after(other.cleanup);
  const before = await readFile(join(other.path, "AGENTS.md"), "utf8");
  await symlink(fixture.path, join(other.path, ".agents"));
  await assert.rejects(initializeProject(other.path, true), { code: "PATH_UNSAFE" });
  assert.equal(await readFile(join(other.path, "AGENTS.md"), "utf8"), before);
  await assert.rejects(access(join(other.path, ".project-dev")), { code: "ENOENT" });
});
