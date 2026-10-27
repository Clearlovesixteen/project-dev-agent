import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AppError } from "../domain/error.js";
import { ToolResultSchema, type ToolResult } from "../domain/result.js";
import { VERSION } from "../version.js";

/** 正式终端降级通道仍通过同一 MCP 注册和范围校验，不提供另一套绕过配置的业务服务。 */
export async function toolClient(input: {
  entry: string;
  project?: string;
  workspace?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}): Promise<ToolResult> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.NODE_TEST_CONTEXT;
  const client = new Client({ name: "project-dev-terminal", version: VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(input.entry),
      "serve",
      ...(input.workspace ? ["--workspace", input.workspace] : ["--plugin"]),
    ],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    if (!input.tool)
      return {
        outcome: "ok",
        code: "TOOL_PREFLIGHT",
        data: {
          version: VERSION,
          runtime_startable: true,
          stdio_connected: true,
          tool_count: list.tools.length,
          tools: list.tools.map((item) => item.name),
          host_tool_visibility: "not_checked",
          scope_mode: input.workspace ? "workspace" : "plugin",
          limitation:
            "该结果证明独立STDIO进程可用；当前Codex会话是否加载工具须检查宿主工具列表，二者不能混为一谈。",
        },
        diagnostics: [],
      };
    if (!list.tools.some((item) => item.name === input.tool))
      throw new AppError(
        "TOOL_NOT_AVAILABLE",
        `当前运行版本没有此工具：${input.tool}`,
      );
    if (
      input.arguments === null ||
      Array.isArray(input.arguments) ||
      (input.arguments !== undefined && typeof input.arguments !== "object")
    )
      throw new AppError("TOOL_INPUT_INVALID", "工具输入文件必须是JSON对象");
    const args = { ...input.arguments };
    if (input.project) {
      if (args.project && args.project !== input.project)
        throw new AppError(
          "PROJECT_BINDING_MISMATCH",
          "输入文件与命令选择的项目不同",
        );
      args.project = input.project;
    }
    const result = await client.callTool({ name: input.tool, arguments: args });
    if (result.structuredContent)
      return ToolResultSchema.parse(result.structuredContent);
    throw new AppError(
      "TOOL_RESULT_INVALID",
      "工具未返回结构化结果，不能认定记录成功",
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "TOOL_CONNECTION_FAILED",
      `${error instanceof Error ? error.message : String(error)}${
        stderr ? "；运行文件诊断：" + stderr : ""
      }`,
    );
  } finally {
    await client.close();
  }
}
