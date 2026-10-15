import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("doctor initializes the pinned MCP SDK while clearly distinguishing a future Codex connection", () => {
  const result = JSON.parse(execFileSync(process.execPath, [cli, "doctor"], { encoding: "utf8" })) as Record<string, unknown>;
  assert.equal(result.outcome, "ok");
  assert.equal(result.mcp_sdk_initialization, "ok");
  assert.equal(result.codex_connection, "not_checked");
});

test("CLI rejects a falsely completed task and returns actionable validation details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-dev-cli-"));
  try {
    const path = join(directory, "invalid.json");
    await writeFile(path, JSON.stringify({
      schema_version: 1, id: "task-1", revision: 0, repo_identity: "/tmp/repo/.git", worktree_path: "/tmp/repo",
      baseline_head: "a".repeat(40), baseline_branch: "main", phase: "closed", requirement: "Disable an account",
      acceptance_criteria: [{ id: "login", description: "Disabled account cannot log in", status: "pending" }],
      change_items: [], created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z",
    }));
    const result = spawnSync(process.execPath, [cli, "contract", "check", "--type", "task", "--file", path], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout) as { code: string; issues: { path: string[] }[] };
    assert.equal(output.code, "INVALID_CONTRACT");
    assert.ok(output.issues.some((issue) => issue.path.includes("acceptance_criteria")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI surfaces malformed JSON as a failure instead of a successful result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-dev-cli-"));
  try {
    const path = join(directory, "broken.json");
    await writeFile(path, "{broken");
    const result = spawnSync(process.execPath, [cli, "contract", "check", "--type", "task", "--file", path], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "COMMAND_FAILED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI uses Chinese help and schema diagnostics while retaining machine fields and codes", async () => {
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /可用命令/);
  assert.match(help, /history record --project/);
  const directory = await mkdtemp(join(tmpdir(), "project-dev-language-"));
  try {
    const path = join(directory, "invalid.json");
    await writeFile(path, JSON.stringify({ schema_version: 1, id: 123 }));
    const result = spawnSync(process.execPath, [cli, "contract", "check", "--type", "task", "--file", path], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.code, "INVALID_CONTRACT");
    const issue = output.issues.find((item: { path: string[] }) => item.path.join(".") === "id");
    assert.equal(issue.code, "invalid_type");
    assert.match(issue.message, /[\u3400-\u9fff]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI bounds record reads and rejects special files without trying to consume them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-dev-cli-"));
  try {
    const path = join(directory, "large.json");
    await writeFile(path, Buffer.alloc(1_000_001, 32));
    const large = spawnSync(process.execPath, [cli, "contract", "check", "--type", "task", "--file", path], { encoding: "utf8", timeout: 5_000 });
    assert.equal(large.status, 1);
    assert.match(JSON.parse(large.stderr).message, /超过 1 MB/);
    if (process.platform !== "win32") {
      const special = spawnSync(process.execPath, [cli, "contract", "check", "--type", "task", "--file", "/dev/zero"], { encoding: "utf8", timeout: 5_000 });
      assert.equal(special.status, 1);
      assert.match(JSON.parse(special.stderr).message, /普通文件/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
