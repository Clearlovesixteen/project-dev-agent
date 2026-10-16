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
import { VERSION } from "./version.js";
import { prepareProject } from "./personal-setup.js";
import { startServer, startWorkspaceServer, startPluginServer } from "./server.js";
import { PluginSettings } from "./plugin-settings.js";
import { initializeProject } from "./setup.js";
import { reviewKnowledge } from "./knowledge/review.js";
import { KnowledgeService } from "./knowledge/service.js";
import { bindWorktree } from "./git/index.js";
import { connectCodex } from "./codex-install.js";
import { HistoryService } from "./history/service.js";
import { UnderstandingService } from "./understanding/service.js";

const HELP = `project-dev-agent — Codex 插件 v${VERSION}

可用命令：
  plugin status
    查看插件版本，以及保存在插件缓存之外的工作目录配置。
  plugin configure --workspace <绝对目录> [--apply --expected-revision <uuid|null>]
    预览或保存工作范围；expected-revision 必须使用预览返回的版本。
  serve --plugin
    启动插件 MCP 服务；首次开发时由 project_prepare 自动初始化当前仓库。
  connect --workspace <绝对目录> [--codex <可执行文件>] [--apply]
    通过 Codex CLI 预览或安装全局 Skill 和工作目录 MCP 连接。
  disconnect --workspace <绝对目录> [--codex <可执行文件>] [--apply]
    移除匹配的已安装 Skill 文件及此 MCP 连接，保留项目记录。
  doctor
    检查 Node、Git 和 MCP SDK 初始化状态；此命令不验证 Codex 连接。
  serve --project <工作区绝对路径>
    启动本地 STDIO MCP 服务，提供任务、知识和经验工具。
  serve --workspace <绝对目录>
    根据明确指定的 Git 项目路径，将工具调用路由到配置范围内的项目。
  project prepare --project <工作区绝对路径> [--apply]
    检查项目准备状态；--apply 为本地任务记录设置 Git 忽略，不修改共享文件。
  project init --project <工作区绝对路径> [--apply]
    预览项目配置；--apply 写入预览列出的项目文件及本地 Codex 配置。
  project scan --project <工作区绝对路径>
    建立或刷新有范围上限的结构索引和 HTML 报告，不修改业务代码。
  project context --project <工作区绝对路径> [--query <关键词>] [--path <相对路径>]
    查询参考文件、直接导入和使用方，以及经过来源核验的模块理解候选。
    --model-id <模型 ID> [--model-revision <修订号>] 读取完整详情；--model-offset <起点> 翻页。
  model record --project <工作区绝对路径> --file <模型 JSON 文件>
    保存有明确范围的业务模型候选，核验源码引用并保留修订版本。
  history scan --project <工作区绝对路径> [--refresh] [--codex-home <目录>]
    发现本地项目对话文本，保留覆盖情况和增量分析进度。
  history next --project <工作区绝对路径> [--batch-id <批次 ID>]
    读取下一批文本或指定批次的当前分析，供 Codex 进行分析或修订。
  history pause --project <工作区绝对路径>
    暂停历史分析，保留已分析和待处理进度。
  history resume --project <工作区绝对路径>
    恢复历史分析并返回下一批待处理文本。
  history record --project <工作区绝对路径> --file <分析 JSON 文件>
    核验用户原话并保存批次分析，更新 HTML 报告。
  history propose --project <工作区绝对路径> --id <候选 ID>
    将历史候选导出到现有的显式知识审查流程。
  knowledge search --project <工作区绝对路径> --query <关键词>
    查找当前有效的已确认项目知识，并提示来源过期的待审查内容。
  knowledge review --project <工作区绝对路径> --file <Markdown 相对路径> --reviewer <姓名>
    审查者显式操作：确认已解决疑问的草稿，并为本地来源生成快照。
  sample create --destination <新目录>
    创建独立的 Git 示例，不修改现有项目。
  contract check --type <task|knowledge|result> --file <JSON 文件>
    验证 v1 数据记录；证据格式有效不代表业务逻辑正确。

知识审查会记录传入的审查者姓名，但不验证其身份，也不替代团队审查。
`;
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readContractFile(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error("数据契约输入必须是普通文件");
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("数据契约输入必须是普通文件");
    const buffer = Buffer.alloc(1_000_001);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 1_000_000) throw new Error("数据契约输入超过 1 MB 限制");
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
      workspace: { type: "string" },
      plugin: { type: "boolean", default: false },
      "expected-revision": { type: "string" },
      codex: { type: "string", default: "codex" },
      apply: { type: "boolean", default: false },
      reviewer: { type: "string" },
      query: { type: "string" },
      path: { type: "string" },
      id: { type: "string" },
      "batch-id": { type: "string" },
      "model-id": { type: "string" },
      "model-revision": { type: "string" },
      "model-offset": { type: "string" },
      refresh: { type: "boolean", default: false },
      "codex-home": { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length === 1 && positionals[0] === "doctor") {
    const server = new McpServer({ name: "project-dev-agent-foundation", version: VERSION });
    await server.close();
    print({ outcome: "ok", version: VERSION, node: process.version,
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(), mcp_sdk_initialization: "ok",
      codex_connection: "not_checked" });
    return;
  }
  if (positionals.length === 1 && ["connect", "disconnect"].includes(positionals[0]!)) {
    if (!values.workspace) throw new Error("connect/disconnect 需要 --workspace <绝对目录>");
    print(await connectCodex({ workspace: values.workspace, codex: values.codex, apply: values.apply, disconnect: positionals[0] === "disconnect" }));
    return;
  }
  if (positionals.length === 1 && positionals[0] === "serve") {
    // mcp.json 使用 serve --plugin；另外两个入口兼容手动绑定仓库或工作目录的安装方式。
    // 三种范围来源互斥，启动后由 STDIO 传输协议消息，不再向 stdout 打印普通命令结果。
    if ([values.project, values.workspace, values.plugin].filter(Boolean).length !== 1) throw new Error("serve 必须且只能指定 --project、--workspace 或 --plugin 中的一项");
    if (values.plugin) await startPluginServer();
    else if (values.workspace) await startWorkspaceServer(values.workspace);
    else await startServer(values.project!);
    return;
  }
  if (positionals.length === 2 && positionals[0] === "plugin") {
    const settings = new PluginSettings(values["codex-home"]);
    if (positionals[1] === "status") print(await settings.status());
    else if (positionals[1] === "configure" && values.workspace) {
      print(await settings.configure({ workspace: values.workspace, apply: values.apply,
        expected_revision: values["expected-revision"] === "null" ? null : values["expected-revision"] }));
    } else throw new Error("请使用 plugin status 或 plugin configure --workspace");
    return;
  }
  if (positionals.length === 2 && positionals[0] === "project" && positionals[1] === "prepare") {
    if (!values.project) throw new Error("project prepare 需要 --project 参数");
    print(await prepareProject(await bindWorktree(values.project), { apply: values.apply }));
    return;
  }
  if (positionals.length === 2 && positionals[0] === "project" && positionals[1] === "init") {
    if (!values.project) throw new Error("project init 需要 --project 参数");
    print(await initializeProject(values.project, values.apply));
    return;
  }
  if (positionals.length === 2 && positionals[0] === "knowledge" && positionals[1] === "review") {
    if (!values.project || !values.file || !values.reviewer) throw new Error("knowledge review 需要 --project、--file 和 --reviewer 参数");
    print({ outcome: "ok", ...(await reviewKnowledge(values.project, values.file, values.reviewer)) });
    return;
  }
  if (positionals.length === 2 && ((positionals[0] === "project" && ["scan", "context"].includes(positionals[1]!)) || (positionals[0] === "model" && positionals[1] === "record"))) {
    if (!values.project) throw new Error("项目理解命令需要 --project 参数");
    const service = new UnderstandingService(await bindWorktree(values.project));
    let result;
    if (positionals[1] === "scan") result = await service.scan({});
    else if (positionals[1] === "context") result = await service.context({ query: values.query ?? "", paths: values.path ? [values.path] : [],
      model_id: values["model-id"], model_revision: values["model-revision"] === undefined ? undefined : Number(values["model-revision"]),
      model_offset: values["model-offset"] === undefined ? 0 : Number(values["model-offset"]) });
    else if (values.file) result = await service.record(JSON.parse(await readContractFile(values.file)));
    else throw new Error("model record 需要 --file 参数");
    print(result); if (result.outcome === "error") process.exitCode = 1; return;
  }
  if (positionals.length === 2 && positionals[0] === "history") {
    if (!values.project) throw new Error("history 需要 --project 参数");
    const service = new HistoryService(await bindWorktree(values.project), values["codex-home"]);
    let result;
    if (positionals[1] === "scan") result = await service.scan({ refresh: values.refresh });
    else if (positionals[1] === "next") result = await service.next({ batch_id: values["batch-id"] });
    else if (["pause", "resume"].includes(positionals[1]!)) result = await service.next({ action: positionals[1] });
    else if (positionals[1] === "record" && values.file) result = await service.record(JSON.parse(await readContractFile(values.file)));
    else if (positionals[1] === "propose" && values.id) result = await service.propose(values.id);
    else throw new Error("请使用 history scan、history next、history pause/resume、history record --file 或 history propose --id");
    print(result);
    if (result.outcome === "error") process.exitCode = 1;
    return;
  }
  if (positionals.length === 2 && positionals[0] === "knowledge" && positionals[1] === "search") {
    if (!values.project || !values.query) throw new Error("knowledge search 需要 --project 和 --query 参数");
    const result = await new KnowledgeService(await bindWorktree(values.project)).search({ query: values.query });
    print(result);
    if (result.outcome !== "ok") process.exitCode = 1;
    return;
  }
  if (positionals.length === 2 && positionals[0] === "sample" && positionals[1] === "create") {
    if (!values.destination) throw new Error("sample create 需要 --destination <新目录>");
    const result = await createSample(resolve(values.destination));
    print({ outcome: "ok", ...result });
    return;
  }
  if (positionals.length === 2 && positionals[0] === "contract" && positionals[1] === "check") {
    const schemas = { task: TaskSchema, knowledge: KnowledgeSchema, result: ToolResultSchema };
    const type = values.type;
    if (!type || !Object.hasOwn(schemas, type) || !values.file) {
      throw new Error("contract check 需要 --type <task|knowledge|result> 和 --file <JSON 文件>");
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
  throw new Error("未知命令。请使用 --help 查看支持的命令。");
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ outcome: "error", code: "COMMAND_FAILED", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
