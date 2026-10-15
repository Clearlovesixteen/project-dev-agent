import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createSample } from "../src/sample/create.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";

const execFileAsync = promisify(execFile);

function standaloneTestEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Nested Node test runners must not inherit the parent's internal runner context.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

interface Account { id: string; email: string; status: string }
interface AccountSystem {
  service: {
    createAccount(input: { id: string; email: string; status?: string }): Account;
    setStatus(id: string, status: string): Account;
    getAccount(id: string): Account | undefined;
  };
  auth: { login(id: string): string; validateSession(token: string): Account };
  view: { getSummary(id: string): Account & { statusLabel: string } };
}

async function loadSystem(path: string): Promise<AccountSystem> {
  const module = await import(pathToFileURL(join(path, "src", "system.js")).href) as {
    createAccountSystem(): AccountSystem;
  };
  return module.createAccountSystem();
}

test("the generated baseline passes its own tests and keeps task state out of Git changes", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  assert.match(fixture.head, /^[0-9a-f]{40}$/);
  const baselineTests = await execFileAsync(process.execPath, ["--test", "--test-reporter=tap"], {
    cwd: fixture.path, env: standaloneTestEnvironment(),
  });
  assert.match(baselineTests.stdout, /# fail 0/);
  assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: fixture.path })).stdout, "");
  await mkdir(join(fixture.path, ".project-dev", "local", "tasks"), { recursive: true });
  await writeFile(join(fixture.path, ".project-dev", "local", "tasks", "example.json"), "{}\n");
  await execFileAsync("git", ["check-ignore", "--quiet", ".project-dev/local/tasks/example.json"], {
    cwd: fixture.path,
  });
  assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: fixture.path })).stdout, "");
  await assert.rejects(access(join(fixture.path, "evals", "oracle.md")));
  const system = await loadSystem(fixture.path);
  assert.throws(() => system.service.createAccount({
    id: "disabled", email: "disabled@example.test", status: "disabled",
  }), /UNSUPPORTED_ACCOUNT_STATUS/);
});

test("a writer-only disabled change still permits login and existing sessions and mislabels the account", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const servicePath = join(fixture.path, "src", "service.js");
  const original = await readFile(servicePath, "utf8");
  assert.ok(original.includes('new Set(["active"])'));
  await writeFile(servicePath, original.replace('new Set(["active"])', 'new Set(["active", "disabled"])'));
  const system = await loadSystem(fixture.path);
  system.service.createAccount({ id: "alice", email: "alice@example.test" });
  const existingSession = system.auth.login("alice");
  system.service.setStatus("alice", "disabled");
  assert.equal(system.service.getAccount("alice")?.status, "disabled");
  // These independent business operations expose the incomplete implementation.
  const newSession = system.auth.login("alice");
  assert.equal(typeof newSession, "string", "the disabled account incorrectly receives a new session");
  assert.equal(system.auth.validateSession(existingSession).status, "disabled", "an existing session incorrectly remains valid");
  assert.deepEqual(system.view.getSummary("alice"), {
    id: "alice", email: "alice@example.test", status: "disabled", statusLabel: "启用",
  }, "the stored status and displayed label contradict each other");
  // Existing tests remain green, illustrating why added behavior needs new verification.
  await execFileAsync(process.execPath, ["--test", "--test-reporter=tap"], {
    cwd: fixture.path, env: standaloneTestEnvironment(),
  });
});

test("sample creation refuses existing empty and nonempty directories without deleting their contents", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const empty = join(fixture.root, "existing-empty");
  await mkdir(empty);
  await assert.rejects(createSample(empty), { code: "EEXIST" });
  await access(empty);
  const sentinel = join(fixture.path, "sentinel.txt");
  await writeFile(sentinel, "keep\n");
  await assert.rejects(createSample(fixture.path), { code: "EEXIST" });
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

test("sample creation refuses a destination inside the tool source", async () => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // Compiled tests run from dist/tests; the actual package root is two levels up.
  const toolRoot = resolve(moduleDirectory, "../..");
  await assert.rejects(createSample(join(toolRoot, "sample-must-not-be-created")), /工具包之外/);
  await assert.rejects(access(join(toolRoot, "sample-must-not-be-created")));
});

test("a failed Git initialization removes only the newly created destination", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const fakeBin = join(fixture.root, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "git"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
  const destination = join(fixture.root, "failed-sample");
  const moduleUrl = new URL("../src/sample/create.js", import.meta.url).href;
  const script = `import { createSample } from ${JSON.stringify(moduleUrl)}; await createSample(process.argv[1]);`;
  await assert.rejects(execFileAsync(process.execPath, ["--input-type=module", "--eval", script, destination], {
    env: { ...process.env, PATH: fakeBin },
  }));
  await assert.rejects(access(destination));
  await access(join(fixture.path, ".git"));
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.path })).stdout.trim(), fixture.head);
});
