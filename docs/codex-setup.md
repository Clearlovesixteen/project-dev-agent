# 安装与日常使用

## 个人安装（v0.2）

环境要求：Node.js 20.19+、npm、Git、已登录的 Codex。工具本身无需模型 API Key，使用当前 Codex 会话完成代码理解和修改。

把安装包放到本机，安装到一个长期保留的目录：

```bash
npm install --prefix "$HOME/Tools/project-dev-agent" /absolute/project-dev-agent-0.2.0.tgz --ignore-scripts
```

注册一次即可用于一个工作目录下的多个独立 Git 仓库。下文 `/absolute/workspace` 也可以是单个仓库：

```bash
node "$HOME/Tools/project-dev-agent/node_modules/project-dev-agent/dist/src/cli.js" connect --workspace /absolute/workspace
node "$HOME/Tools/project-dev-agent/node_modules/project-dev-agent/dist/src/cli.js" connect --workspace /absolute/workspace --apply
```

第一条预览，第二条执行。它通过 `codex mcp add` 添加 `project_dev`，并将 Skill 安装到 `~/.agents/skills/project-dev`。其他 MCP 连接保留。同名连接或 Skill 与当前版本不一致时会停止并保留原内容，需先核对差异，不能强行覆盖。

若终端找不到 `codex`，给两条命令增加 `--codex /absolute/path/to/codex`。macOS 的本次桌面安装所用路径为 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，其他机器应以实际安装路径为准。

Codex 桌面、CLI 和 IDE 共享用户 MCP 配置。配置说明见 [官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。安装后在目标仓库新建 Codex 会话；若还没有工具，在 Settings → MCP servers 中重启 `project_dev` 连接，再开始新会话。

## 直接开始一个需求

在工作目录内的具体仓库打开会话，例如：

```text
$project-dev 帮我实现这个需求：……
先找项目里已有的实现方式，梳理涉及的入口和关联代码，再修改并验证。
```

Codex 会读取当前仓库规则和相关实现，检查任务状态，建立验收项和关联清单，然后改代码并记录验证。在第一批知识尚未整理时，直接利用已有代码、AGENTS.md 和业务文档。

首次使用时，`project_prepare` 只向 Git 本地的 `info/exclude` 追加 `/.project-dev/local/`；它不修改业务文件、共享 AGENTS.md 或 .gitignore。任务和候选经验随后写到忽略目录。可以只预览：

```bash
node /absolute/installed-package/dist/src/cli.js project prepare --project /absolute/repository
```

开始任务要求工作树干净。已有改动时先保留，由开发者决定完成提交还是使用干净 worktree。工具不会替你 stash、reset 或 commit。workspace 模式要求工作树及其 Git 元数据都位于配置目录内；位于目录外的 Codex 托管 worktree 暂不包含在此连接范围。

切换会话后可说：

```text
$project-dev 继续当前仓库上次未完成的任务，先恢复记录。
```

`task_check` 不传任务 ID 时恢复当前仓库的唯一活动任务。一个仓库的任务不会自动转移到另一个仓库；每次工具调用都传当前 Git 根目录。根目录含多个项目时，应打开具体项目或在请求中点明项目。

## 纠正与知识积累

直接在对话中指出实现方式及原因，例如“这里应复用现有封装，另外两个入口也要同步处理”。Agent 会更新当前任务，并可把适合复用的经验写成候选草稿。候选内容不会自动升级为团队规则。

需要共享时，按 [经验审查](knowledge-review.md) 核对适用范围、来源和问题，再显式审查。共享知识放入项目的 `.project-dev/knowledge/`，通过普通 Git 审查维护。团队成员安装相同工具并拉取知识即可使用，不需要中央服务。

## 团队接入

先让个人试用经过真实需求验证，再按 [试用指南](pilot-guide.md) 收集纠偏次数、关联遗漏及额外操作成本；不能以测试通过替代团队收益评估。

每位同事安装同一版本的 tgz 并执行上面的 connect，workspace 使用自己的本地路径。若需统一项目配置、Skill 和共享说明，可执行原有 `project init --project /absolute/repository` 预览，再带 `--apply` 写入；这会产生团队需要审查的 Git 变更。个人模式不要求先执行该命令。团队级 Skill 与全局 Skill 应保持同一版本，避免旧的项目 Skill 遮蔽新版本。

## 断开与保留数据

```bash
node /absolute/installed-package/dist/src/cli.js disconnect --workspace /absolute/workspace
node /absolute/installed-package/dist/src/cli.js disconnect --workspace /absolute/workspace --apply
```

断开仅移除匹配的 `project_dev` 连接和未经修改的已安装 Skill 文件；自定义冲突会先停止。项目任务、知识、Git 本地忽略规则和工具安装目录均保留，需要时重新连接即可。它不是清理开发成果的命令。

## 排查

- 找不到 Skill：确认安装结果的 Skill 路径，并新建会话。
- 找不到 MCP 工具：检查 Settings → MCP servers / `/mcp`，或 `codex mcp get project_dev --json`；重启连接。
- `PROJECT_OUTSIDE_WORKSPACE`：当前仓库或 Git 元数据位于配置目录外；核对实际项目路径。
- `WORKTREE_DIRTY`：先处理已有改动；不要为满足工具而自动丢弃或提交内容。
- `ACTIVE_TASK_EXISTS`：用 `task_check` 恢复，不能随意新建替换旧任务。
- `BASELINE_BRANCH_CHANGED`：已经切换分支；返回原分支继续，或明确中止旧任务。
- `SKILL_CONFLICT` / `MCP_CONFIG_CONFLICT`：同名配置不一致；保留原内容后比较，不覆盖未知配置。
- `doctor` 只验证 Node/Git/SDK 初始化；它不证明桌面当前会话已加载连接。
