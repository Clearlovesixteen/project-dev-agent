import assert from "node:assert/strict";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { connectCodex } from "../src/codex-install.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { fileURLToPath } from "node:url";

function configuration() {
  const unrelated = { name: "existing", enabled: true, transport: { type: "stdio", command: "other-tool", args: ["--keep"] } };
  let servers = [structuredClone(unrelated)];
  const mutations: string[][] = [];
  const runCodex = async (args: string[]) => {
    if (args[1] === "list") return JSON.stringify(servers);
    mutations.push(args);
    if (args[1] === "add") servers.push({ name: args[2]!, enabled: true, transport: { type: "stdio", command: args[4]!, args: args.slice(5) } });
    else if (args[1] === "remove") servers = servers.filter((server) => server.name !== args[2]);
    else throw new Error("Unexpected configuration command");
    return "ok";
  };
  return { unrelated, mutations, runCodex, servers: () => servers };
}

test("connect previews, installs, repeats and disconnects while preserving unrelated servers and project content", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const home = join(fixture.root, "user home");
  await mkdir(home);
  const config = configuration();
  const options = { workspace: fixture.root, codex: "fake-codex", userHome: home, runCodex: config.runCodex, apply: false };
  await connectCodex(options);
  assert.equal(config.mutations.length, 0);
  const skill = join(home, ".agents/skills/project-dev/SKILL.md");
  await assert.rejects(access(skill), { code: "ENOENT" });
  await connectCodex({ ...options, apply: true });
  assert.match(await readFile(skill, "utf8"), /name: project-dev/);
  const installed = config.servers().find((server) => server.name === "project_dev")!;
  assert.deepEqual(installed.transport.args.slice(-3), ["serve", "--workspace", await realpath(fixture.root)]);
  await connectCodex({ ...options, apply: true });
  assert.equal(config.mutations.length, 1);
  await connectCodex({ ...options, apply: true, disconnect: true });
  assert.deepEqual(config.servers(), [config.unrelated]);
  await assert.rejects(access(skill), { code: "ENOENT" });
  await access(join(fixture.path, "src/service.js"));
});

test("installer refuses customized skill or conflicting MCP before writing and preserves edits during disconnect", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const home = join(fixture.root, "user home");
  const skillDir = join(home, ".agents/skills/project-dev");
  await mkdir(skillDir, { recursive: true });
  const skill = join(skillDir, "SKILL.md");
  await writeFile(skill, "custom skill\n");
  const config = configuration();
  const options = { workspace: fixture.root, codex: "fake", userHome: home, runCodex: config.runCodex, apply: true };
  await assert.rejects(connectCodex(options), { code: "SKILL_CONFLICT" });
  await assert.rejects(connectCodex({ ...options, disconnect: true }), { code: "SKILL_CONFLICT" });
  assert.equal(config.mutations.length, 0);
  assert.equal(await readFile(skill, "utf8"), "custom skill\n");
  const conflicts = async () => JSON.stringify([{ name: "project_dev", transport: { type: "stdio", command: "someone-else" } }]);
  await assert.rejects(connectCodex({ ...options, runCodex: conflicts }), { code: "MCP_CONFIG_CONFLICT" });
});

test("failed Codex registration rolls back only skill files created in that attempt", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const home = join(fixture.root, "user home");
  await mkdir(home);
  const runCodex = async (args: string[]) => {
    if (args[1] === "list") return "[]";
    throw new Error("Simulated registration failure");
  };
  await assert.rejects(connectCodex({ workspace: fixture.root, codex: "fake", userHome: home, runCodex, apply: true }), /Simulated registration failure/);
  await assert.rejects(access(join(home, ".agents/skills/project-dev/SKILL.md")), { code: "ENOENT" });
});

test("known v0.2.1 skill upgrades in place and failed registration restores that exact predecessor", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(await realpath(fixture.root), "upgrade home");
  const directory = join(home, ".agents/skills/project-dev"); await mkdir(directory, { recursive: true });
  const old = await readFile(fileURLToPath(new URL("../../templates/previous-skills/v0.2.1/SKILL.md", import.meta.url)), "utf8");
  const path = join(directory, "SKILL.md"); await writeFile(path, old);
  const options = { workspace: fixture.root, codex: "fake", userHome: home, apply: true };
  const failing = async (args: string[]) => { if (args[1] === "list") return "[]"; throw new Error("registration failed"); };
  await assert.rejects(connectCodex({ ...options, runCodex: failing }), /registration failed/);
  assert.equal(await readFile(path, "utf8"), old);
  await assert.rejects(access(join(directory, "references/history-inputs.md")), { code: "ENOENT" });
  const config = configuration();
  const preview = await connectCodex({ ...options, runCodex: config.runCodex, apply: false });
  assert.equal(preview.skill_files.find((file) => file.file === path)?.action, "update");
  assert.equal(await readFile(path, "utf8"), old);
  await connectCodex({ ...options, runCodex: config.runCodex });
  assert.notEqual(await readFile(path, "utf8"), old);
  await access(join(directory, "references/history-inputs.md"));
  const repeated = await connectCodex({ ...options, runCodex: config.runCodex });
  assert.ok(repeated.skill_files.every((file) => file.action === "unchanged"));
});

for (const version of ["v0.3.0", "v0.4.0", "v0.5.0"]) test(`exact ${version} skill upgrades with project understanding and current startup instructions`, async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const home = join(await realpath(fixture.root), "v03 home"), directory = join(home, ".agents/skills/project-dev");
  await mkdir(directory, { recursive: true });
  const old = await readFile(fileURLToPath(new URL(`../../templates/previous-skills/${version}/SKILL.md`, import.meta.url)), "utf8");
  await writeFile(join(directory, "SKILL.md"), old);
  const config = configuration();
  await connectCodex({ workspace: fixture.root, codex: "fake", userHome: home, apply: true, runCodex: config.runCodex });
  const current = await readFile(join(directory, "SKILL.md"), "utf8");
  assert.notEqual(current, old);
  assert.match(current, /project_scan/);
  await access(join(directory, "references/understanding-inputs.md"));
});
