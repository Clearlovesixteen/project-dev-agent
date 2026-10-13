# Codex 接入与分发

## 安装

在工具源码目录执行 `npm ci --ignore-scripts` 和 `npm run build`。也可将构建后的 npm 包交给同事，在本机安装后使用。工具包与目标项目独立，配置路径指向本机实际位置。

使用已构建安装包时，无需 TypeScript 编译器。在单独的工具目录安装后使用其 CLI：

```bash
npm install --prefix /absolute/tool-home /absolute/project-dev-agent-0.1.0.tgz --ignore-scripts
/absolute/tool-home/node_modules/.bin/project-dev-agent doctor
/absolute/tool-home/node_modules/.bin/project-dev-agent project init --project /absolute/project
```

以下命令展示源码构建后的同等入口：

```bash
node /absolute/tool/dist/src/cli.js project init --project /absolute/project
node /absolute/tool/dist/src/cli.js project init --project /absolute/project --apply
```

预览展示拟写入的文件。初始化只操作指定项目，写入项目 Skill、知识配置、AGENTS 指引、忽略项和本机配置，不写全局 Codex 配置。自定义文件保留并显示提示。项目设置变更先走正常 Git 流程，再开始首个开发任务。

切换 worktree 时，在新工作树重新初始化并使用对应绝对路径。任务状态不在工作树间搬用。

## 连接 MCP

将生成的 `.project-dev/local/codex.toml` 内容加入目标 Codex 的 MCP 设置。它包含 Node、构建后的 CLI 和项目的绝对路径。启动新会话，检查五个工具：`task_open/update/check`、`knowledge_search`、`experience_propose`。

调用 `$project-dev` 后提出需求。Skill 引导查知识、读代码、保存清单、实施和核对；MCP 本身不运行模型。

配置依据 [官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，项目 Skill 目录和调用方式见 [官方 Skills 文档](https://learn.chatgpt.com/docs/build-skills)。

## 本地插件

工具包根目录的 `plugin.json` 包装通用 Skill。初始化还生成 `.project-dev/local/plugin/`，包含 Skill、根 `plugin.json` 和根 `mcp.json`，MCP 明确绑定当前工作树和工具路径。这是本机安装产物，不能原样复制路径给其他电脑。

分发通用工具包后，同事应在各自机器生成配置。结构依据 [官方插件打包文档](https://developers.openai.com/plugins/build/plugins)。生成文件和协议连接测试不能替代桌面客户端的安装验证，当前状态见 [验证报告](verification.md)。

如目标客户端暂不支持加载本地插件，可直接配置同一本地 MCP 并使用项目 Skill。

## 重启与失败

MCP stdout 只输出协议。重启后，`task_check` 按任务 ID 恢复记录。`REVISION_CONFLICT` 时读取最新记录再更新；`STORE_BUSY` 表示有进程在写状态。已退出进程留下的有效锁可以恢复；损坏锁应保留并检查。

`WORKTREE_DIRTY` 表示开任务前尚有变更；`STATE_DIRECTORY_NOT_IGNORED` 表示忽略配置失效；`UNMERGED_CHANGES`、`BASELINE_BRANCH_CHANGED`、`BASELINE_NOT_REACHABLE` 需要处理 Git 状态。不要删除历史任务或伪造完成记录来绕过失败。
