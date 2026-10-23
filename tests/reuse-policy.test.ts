import { withImplementationBasis } from "./helpers/implementation-basis.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { UnderstandingService } from "../src/understanding/service.js";
import { TaskService } from "../src/task-service.js";
import { ToolResultSchema } from "../src/domain/result.js";
import { TaskSchema } from "../src/domain/task.js";

async function setup(t: { after: (action: () => Promise<void>) => void }) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const put = async (path: string, content: string) => { await mkdir(join(fixture.path, path, ".."), { recursive: true }); await writeFile(join(fixture.path, path), content); };
  await put("src/platform/transport.ts", "import axios from 'axios';\nexport const transport = axios.create({baseURL: '/api'});\ntransport.interceptors.request.use(config => config);\n");
  await put("src/modules/catalog/api.ts", "import {transport} from '../../platform/transport';\nexport const loadCatalog = () => transport.get('/catalog');\n");
  await put("src/modules/orders/api.ts", "import {transport} from '../../platform/transport';\nexport const loadOrders = () => transport.get('/orders');\n");
  // 夹具的临时提交使用固定身份并关闭钩子/签名，不依赖开发机或 CI 的个人 Git 配置。
  const git = (args: string[]) => execFileSync("git", ["-C", fixture.path, "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", "-c", "user.name=Reuse Regression", "-c", "user.email=reuse-regression@example.invalid", ...args]);
  git(["add", "src"]); git(["commit", "-m", "existing request facade"]);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root), service = new UnderstandingService(binding), tasks = new TaskService(binding);
  assert.equal((await service.scan({})).outcome, "ok");
  const task = TaskSchema.parse((await tasks.open(await withImplementationBasis(fixture.path, { requirement: "新增独立退款模块，遵循已有项目约定", acceptance_criteria: [{ id: "reuse", description: "复用项目既有请求能力" }] }))).data);
  return { fixture, binding, files, service, tasks, task, put };
}

test("全新业务目录没有索引命中时，仍返回项目级请求入口和现有模块用法", async t => {
  const { service } = await setup(t);
  const result = (await service.context({ paths: ["src/modules/refunds"], query: "新增退款模块" })).data as any;
  const context = result.implementation_context;
  assert.ok(context, "新目录不能导致项目已有基础设施从编码上下文消失");
  assert.ok(context.request_entries.some((entry: any) => entry.path === "src/platform/transport.ts"));
  assert.ok(context.examples.some((entry: any) => entry.path === "src/modules/catalog/api.ts"));
});

test("新增独立模块另起 axios 客户端时会提示重复封装，清单全完成也不能直接关闭", async t => {
  const { put, tasks, task } = await setup(t);
  await put("src/modules/refunds/api.ts", "import axios from 'axios';\nconst client = axios.create({baseURL: '/api'});\nexport const refund = () => client.post('/refund');\n");
  const check = (await tasks.check({})).data as any;
  assert.ok(check.quality.reuse?.violations.some((item: any) => item.path === "src/modules/refunds/api.ts"), "必须发现绕过既有请求封装的新增代码");
  const review = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "fixture", summary: "夹具中的表面完整审查" }] };
  const closed = await tasks.update({ task_id: task.id, expected_revision: 0, review_snapshot: check.review_snapshot, phase: "closed",
    acceptance_criteria: task.acceptance_criteria.map(item => ({ ...item, ...review })),
    change_items: check.changed_paths.map((path: string, index: number) => ({ id: `change-${index}`, target_path: path, action: "modify", requirement: "新增退款", rationale: "独立业务模块", sources: [{ kind: "code", reference: path }], ...review })) });
  assert.equal(closed.code, "PROJECT_REUSE_REQUIRED");
});

test("复用既有入口可正常完成，不强迫新增封装或额外用户操作", async t => {
  const { put, tasks, task } = await setup(t);
  await put("src/modules/refunds/api.ts", "import {transport} from '../../platform/transport';\nexport const refund = () => transport.post('/refund');\n");
  const check = (await tasks.check({})).data as any; assert.equal(check.quality.reuse.state, "checked");
  const review = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "src/modules/refunds/api.ts", summary: "沿用项目统一 transport" }] };
  const closed = await tasks.update({ task_id: task.id, expected_revision: 0, review_snapshot: check.review_snapshot, phase: "closed",
    acceptance_criteria: task.acceptance_criteria.map(item => ({ ...item, ...review })), change_items: [{ id: "refund", target_path: "src/modules/refunds/api.ts", action: "modify", requirement: "新增退款", rationale: "业务层复用统一请求入口", sources: [{ kind: "code", reference: "src/platform/transport.ts" }], ...review }] });
  assert.equal(closed.outcome, "ok", JSON.stringify(closed));
});

test("原请求库的维护、未变化旧调用、类型和注释不算新增重复封装", async t => {
  const { put, tasks } = await setup(t);
  await put("src/platform/transport.ts", "import axios from 'axios';\nexport const transport = axios.create({baseURL: '/api', timeout: 3000});\n");
  await put("src/modules/refunds/types.ts", "import type {AxiosRequestConfig} from 'axios';\n// axios.create();\nconst text = \"axios.get('/demo')\";\nexport type Options = AxiosRequestConfig;\n");
  const check = (await tasks.check({})).data as any;
  assert.equal(check.quality.reuse.violations.length, 0); assert.equal(check.quality.reuse.state, "checked");
});

test("重新扫描后新写客户端不能反过来成为任务的既有基础设施", async t => {
  const { put, tasks, service, task } = await setup(t);
  const original = JSON.stringify(task.implementation_baseline);
  await put("src/modules/refunds/http.ts", "import api from 'axios';\nexport const refundClient = api.create();\n");
  await put("src/modules/refunds/api.ts", "import {refundClient} from './http';\nexport const refund = () => refundClient.post('/refund');\n");
  await service.scan({});
  const check = (await tasks.check({})).data as any;
  assert.ok(check.quality.reuse.violations.some((item: any) => item.path === "src/modules/refunds/http.ts"));
  assert.equal(JSON.stringify(check.recorded_task.implementation_baseline), original);
});

test("必要例外必须记录理由与实际读取的既有封装原文，伪引用不能解除检查", async t => {
  const { put, tasks, task, files } = await setup(t);
  const { digest } = await import("../src/knowledge/document.js");
  await put("src/modules/refunds/api.ts", "import http from 'axios';\nexport const refundClient = http.create({baseURL: 'https://external.example'});\n");
  const check = (await tasks.check({})).data as any;
  const source = await files.read("src/platform/transport.ts");
  const review = { status: "checked", reviewed_by: "fixture", evidence: [{ kind: "manual", reference: "fixture", summary: "核实外部服务隔离要求" }] };
  const change = { id: "refund", target_path: "src/modules/refunds/api.ts", action: "modify", requirement: "外部服务独立认证", rationale: "已有业务认证不能发送到外部服务", sources: [{ kind: "code", reference: "src/platform/transport.ts" }], ...review,
    reuse_exception: { capability: "http", reason: "外部服务需要隔离认证，现有入口未提供隔离扩展点，保留独立客户端并验证不携带业务凭证。", inspected_path: "src/platform/transport.ts", sha256: digest(source), line: 2, quote: "伪造的限制说明" } };
  const base = { task_id: task.id, expected_revision: 0, review_snapshot: check.review_snapshot, phase: "closed", acceptance_criteria: task.acceptance_criteria.map(item => ({ ...item, ...review })) };
  assert.equal((await tasks.update({ ...base, change_items: [change] })).code, "PROJECT_REUSE_REQUIRED");
  const valid = { ...change, reuse_exception: { ...change.reuse_exception, quote: "export const transport = axios.create({baseURL: '/api'});" } };
  assert.equal((await tasks.update({ ...base, change_items: [valid] })).outcome, "ok");
});

test("排除路径不会通过全局复用上下文泄漏，发现候选不表示已阅读代码", async t => {
  const { put, service } = await setup(t);
  await put(".project-dev/project.yaml", "schema_version: 1\nexclude_paths:\n  - src/platform/**\n");
  const result = (await service.context({ paths: ["src/modules/refunds"] })).data as any;
  assert.ok(!result.implementation_context.request_entries.some((item: any) => item.path.startsWith("src/platform")));
  assert.ok(!result.implementation_context.examples.some((item: any) => item.path.startsWith("src/platform")));
});

test("HTTP 静态检查识别导入别名，忽略本地 fetch 封装与字符串示例", async () => {
  const { httpUsage } = await import("../src/quality/http-usage.js");
  assert.ok(httpUsage("import api from 'axios'; const c = api.create();").has("axios:create"));
  assert.ok(httpUsage("const api = require('axios'); api.post('/x');").has("axios:post"));
  assert.ok(httpUsage("import {Axios as Client} from 'axios'; new Client();").has("axios:call"));
  assert.equal(httpUsage("import {fetch} from './platform'; fetch('/x');").size, 0);
  assert.equal(httpUsage("// import api from 'axios'; api.create();\nconst text = 'fetch()';").size, 0);
  assert.equal(httpUsage("import type {AxiosInstance} from 'axios';").size, 0);
  assert.ok(httpUsage("globalThis.fetch('/x');").has("fetch:call"));
});

test("旧任务没有公共能力快照时按 Git 基线恢复检查，不能接受本轮新封装", async t => {
  const { put, tasks, task, files, binding } = await setup(t);
  const path = `.project-dev/local/tasks/${task.id}.json`;
  const current = JSON.parse(await files.read(path, 1_000_000)); delete current.implementation_baseline;
  await writeFile(join(binding.root, path), JSON.stringify(current));
  await put("src/modules/refunds/api.ts", "import axios from 'axios';\nexport const client = axios.create();\n");
  const result = await tasks.check({});
  assert.equal(result.code, "PROJECT_REUSE_REQUIRED");
  assert.equal((result.data as any).quality.reuse.violations.length, 1);
});

test("公共能力快照不可改写，避免把新增客户端伪装为已有规范", async t => {
  const { binding, task } = await setup(t);
  const { TaskStore } = await import("../src/storage/task-store.js");
  const store = new TaskStore(binding.root);
  await assert.rejects(() => store.update(task.id, 0, current => ({ ...current, implementation_baseline: { ...current.implementation_baseline!, request_entries: [] } })), /不能事后改写/);
});

test("没有现成请求入口的新项目可以按需求建立基础能力", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), service = new UnderstandingService(binding), tasks = new TaskService(binding);
  await service.scan({});
  await tasks.open({ requirement: "新项目确需请求能力", acceptance_criteria: [{ id: "first", description: "实现最小请求能力" }] });
  await writeFile(join(binding.root, "src/http.ts"), "import axios from 'axios';\nexport const http = axios.create();\n");
  const check = (await tasks.check({})).data as any;
  assert.equal(check.quality.reuse.state, "checked"); assert.equal(check.quality.reuse.violations.length, 0);
});

test("真实 STDIO 在新模块查询中返回旧入口，并在重启后保留复用检查", async t => {
  const { fixture, put } = await setup(t);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { fileURLToPath } = await import("node:url");
  const connect = async () => {
    const client = new Client({ name: "reuse-regression", version: "1" }); t.after(() => client.close());
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.NODE_TEST_CONTEXT;
    await client.connect(new StdioClientTransport({ command: process.execPath, env, args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--project", fixture.path], stderr: "pipe" }));
    return client;
  };
  const first = await connect();
  const context = await first.callTool({ name: "project_context", arguments: { paths: ["src/modules/refunds"] } });
  assert.ok((context.structuredContent as any).data.implementation_context.request_entries.some((entry: any) => entry.path === "src/platform/transport.ts"));
  await put("src/modules/refunds.ts", "import axios from 'axios';\nexport const client = axios.create();\n");
  const violation = await first.callTool({ name: "task_check", arguments: {} });
  assert.equal(ToolResultSchema.parse(violation.structuredContent).code, "PROJECT_REUSE_REQUIRED");
  await first.close(); const second = await connect();
  const restored = await second.callTool({ name: "task_check", arguments: {} });
  assert.equal(ToolResultSchema.parse(restored.structuredContent).code, "PROJECT_REUSE_REQUIRED");
  await put("src/modules/refunds.ts", "import {transport} from '../platform/transport';\nexport const refund = () => transport.post('/refund');\n");
  const reused = await second.callTool({ name: "task_check", arguments: {} });
  assert.equal((reused.structuredContent as any).data.quality.reuse.state, "checked");
});
