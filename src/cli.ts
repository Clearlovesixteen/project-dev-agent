#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KnowledgeSchema } from "./domain/knowledge.js";
import { ToolResultSchema } from "./domain/result.js";
import { TaskSchema } from "./domain/task.js";
import { createSample } from "./sample/create.js";
import { startServer } from "./server.js";
import { initializeProject } from "./setup.js";
import { reviewKnowledge } from "./knowledge/review.js";
import { KnowledgeService } from "./knowledge/service.js";
import { bindWorktree } from "./git/index.js";

const HELP = `project-dev-agent — prototype v0.1

Commands:
  doctor
    Check Node, Git and MCP SDK initialization. This does not test a Codex connection.
  serve --project <absolute-worktree-path>
    Start the local STDIO MCP service with task, knowledge and experience tools.
  project init --project <absolute-worktree-path> [--apply]
    Preview project setup; --apply writes the shown project files and local Codex configuration.
  knowledge search --project <absolute-worktree-path> --query <words>
    Find current confirmed project knowledge, with review hints for stale sources.
  knowledge review --project <absolute-worktree-path> --file <relative-markdown-path> --reviewer <name>
    Explicit reviewer action: confirm a resolved draft and snapshot its local sources.
  sample create --destination <new-directory>
    Create a standalone Git sample without changing an existing project.
  contract check --type <task|knowledge|result> --file <json-file>
    Validate a v1 data record. Valid evidence format does not prove business correctness.

Knowledge review records the supplied reviewer; it does not authenticate that identity or replace team review.
`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readContractFile(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error("Contract input must be a regular file");
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Contract input must be a regular file");
    const buffer = Buffer.alloc(1_000_001);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 1_000_000) throw new Error("Contract input exceeds 1 MB");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      destination: { type: "string" },
      type: { type: "string" },
      file: { type: "string" },
      project: { type: "string" },
      apply: { type: "boolean", default: false },
      reviewer: { type: "string" },
      query: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length === 1 && positionals[0] === "doctor") {
    const server = new McpServer({ name: "project-dev-agent-foundation", version: "0.1.0" });
    await server.close();
    print({ outcome: "ok", stage: "prototype", node: process.version,
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(), mcp_sdk_initialization: "ok",
      codex_connection: "not_checked" });
    return;
  }
  if (positionals.length === 1 && positionals[0] === "serve") {
    if (!values.project) throw new Error("serve requires --project <absolute-worktree-path>");
    await startServer(values.project);
    return;
  }
  if (positionals.length === 2 && positionals[0] === "project" && positionals[1] === "init") {
    if (!values.project) throw new Error("project init requires --project");
    print(await initializeProject(values.project, values.apply));
    return;
  }
  if (positionals.length === 2 && positionals[0] === "knowledge" && positionals[1] === "review") {
    if (!values.project || !values.file || !values.reviewer) throw new Error("knowledge review requires --project, --file and --reviewer");
    print({ outcome: "ok", ...(await reviewKnowledge(values.project, values.file, values.reviewer)) });
    return;
  }
  if (positionals.length === 2 && positionals[0] === "knowledge" && positionals[1] === "search") {
    if (!values.project || !values.query) throw new Error("knowledge search requires --project and --query");
    const result = await new KnowledgeService(await bindWorktree(values.project)).search({ query: values.query });
    print(result);
    if (result.outcome !== "ok") process.exitCode = 1;
    return;
  }
  if (positionals.length === 2 && positionals[0] === "sample" && positionals[1] === "create") {
    if (!values.destination) throw new Error("sample create requires --destination <new-directory>");
    const result = await createSample(resolve(values.destination));
    print({ outcome: "ok", ...result });
    return;
  }
  if (positionals.length === 2 && positionals[0] === "contract" && positionals[1] === "check") {
    const schemas = { task: TaskSchema, knowledge: KnowledgeSchema, result: ToolResultSchema };
    const type = values.type;
    if (!type || !Object.hasOwn(schemas, type) || !values.file) {
      throw new Error("contract check requires --type <task|knowledge|result> --file <json-file>");
    }
    const raw = await readContractFile(resolve(values.file));
    const schema = schemas[type as keyof typeof schemas];
    const result = schema.safeParse(JSON.parse(raw) as unknown);
    if (!result.success) {
      print({ outcome: "error", code: "INVALID_CONTRACT", issues: result.error.issues });
      process.exitCode = 1;
      return;
    }
    print({ outcome: "ok", schema_version: 1, type, data: result.data });
    return;
  }
  throw new Error("Unknown command. Use --help to see supported commands.");
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ outcome: "error", code: "COMMAND_FAILED", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
