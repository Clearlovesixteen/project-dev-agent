# Project Dev Agent

**让 Codex 在改代码前了解项目惯例、业务背景和相关改动范围，并把开发中的纠正经验留给下一次任务。**

这是接入 Codex 的开发辅助工具，适合已经用 Codex 修改项目、但仍需要反复纠正实现思路的开发者。它可以用于不同业务项目，不绑定某一个系统。

当前版本：**v0.4.0，供个人使用和小范围团队验证**。采用 Git 源码安装和更新，尚未提供插件市场一键安装或自动更新。

## 它能帮你做什么

| 常见问题 | 工具如何帮助 |
| --- | --- |
| Codex 不熟悉项目的代码习惯 | 建立项目结构索引，寻找同类实现、公共组件和已有封装，提供可核对的参考路径。 |
| 每次都要重新解释业务背景 | 围绕具体需求整理术语、流程和模块职责，保存源码依据，后续任务可以检索复用。 |
| 只修改当前文件，遗漏其他入口 | 结合直接引用、使用方和业务关系建立关联改动清单，结束前逐项检查。 |
| 以前纠正过的问题又出现 | 分析本机属于该项目的 Codex 历史对话，提取带原话来源的习惯候选和业务纠正。 |
| 换个对话就丢失开发进度 | 保存任务、验收项、关联清单和验证记录，在同一仓库恢复未完成的任务。 |

例如，修改一个订单状态的展示时，Agent 会先查找已有状态定义和展示组件，再核对列表、详情、筛选项及测试是否涉及这次变化。需要同步修改的地方和只需验证的地方都会进入清单；实际范围仍需结合当前代码判断。

## 开始前准备

- **Node.js 20.19 或以上版本**，以及 npm、Git。
- 已安装并登录 Codex，能够使用它的 CLI 配置 MCP。
- 拥有本私有仓库的访问权限。使用 SSH 克隆时，本机需已配置 GitHub SSH 密钥。
- 准备一个已有 Git 提交的业务仓库，或一个包含多个 Git 仓库的工作目录。

工具无需单独的模型 API Key、数据库或向量服务。理解需求和分析代码使用当前 Codex 会话，会消耗该会话的额度。

## 首次安装

### 1. 获取并构建工具

在终端执行。工具目录需要长期保留，Codex 会从这里启动本地服务。

```bash
mkdir -p "$HOME/Tools"
git clone git@github.com:Clearlovesixteen/project-dev-agent.git "$HOME/Tools/project-dev-agent"
cd "$HOME/Tools/project-dev-agent"
npm ci --ignore-scripts && npm run build
```

如果使用 HTTPS，可将克隆地址替换为 `https://github.com/Clearlovesixteen/project-dev-agent.git`，使用自己已配置的 GitHub 认证方式。

### 2. 连接你的业务工作目录

下面的 `/absolute/workspace` 是占位符，**必须替换成你电脑上已有的绝对路径**。路径包含空格时保留引号。

例如，你有两个仓库 `/Users/your-name/Projects/project-a` 和 `/Users/your-name/Projects/project-b`，可以将 workspace 设置为 `/Users/your-name/Projects`；也可以只设置一个仓库的路径。

先预览，再应用：

```bash
node dist/src/cli.js connect --workspace "/absolute/workspace"
node dist/src/cli.js connect --workspace "/absolute/workspace" --apply
```

这一步会：

1. 注册名为 `project_dev` 的本地 MCP 服务，绑定你的工作目录。
2. 将 `project-dev` Skill 安装到 `~/.agents/skills/project-dev`。
3. 保留已有的其他 MCP 配置；遇到同名配置或自定义 Skill 冲突时停止，提示核对。

**工具源码目录与业务工作目录是两个不同的用途。** 前者存放这个工具，后者是你希望 Agent 帮助开发的项目范围。日常使用时，在范围内的具体业务仓库打开 Codex 对话。

如果提示找不到 `codex`，为 `connect` / `disconnect` 命令加上 `--codex`，指定本机实际的 CLI 路径。例如，某些 macOS 桌面安装使用以下路径：

```bash
node dist/src/cli.js connect \
  --workspace "/absolute/workspace" \
  --codex "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" \
  --apply
```

CLI 路径以你电脑上的安装位置为准。后续更新和断开时也需要使用同一路径。

### 3. 在 Codex 中确认接入

在 workspace 内的**具体业务仓库**新建 Codex 对话，输入：

```text
$project-dev 接入当前项目，生成项目理解报告。
```

接入后应能看到 Agent 调用 `project_prepare`、`project_scan` 等工具，并返回项目扫描结果及报告路径。如果工具尚未出现，在 Codex 的 MCP 设置中重启 `project_dev` 连接，再新建对话。

也可以在工具源码目录运行环境检查：

```bash
node dist/src/cli.js doctor
```

`doctor` 成功表示 Node、Git 和 MCP SDK 可以运行；其中 `codex_connection: "not_checked"` 表示它没有检查当前 Codex 对话。**实际接入成功以对话中能够调用工具为准。**

## 第一次接入项目，会发生什么

1. **确认项目范围。** 定位当前 Git 仓库，在 Git 本地忽略规则中加入 `.project-dev/local/`，用于保存个人记录。
2. **建立结构索引。** 扫描允许读取的源码和配置，识别目录、模块、页面入口、公共能力及直接导入关系，并报告已扫描、排除和未覆盖的范围。
3. **整理项目历史。** 查找本机 Codex 普通及归档会话中能够归属当前仓库的可见对话文本，由当前 Codex 会话分批分析，保存带用户原话的习惯候选。没有历史也可以继续使用。
4. **按需求加深理解。** 做到具体模块时，再核对业务流程、术语和相关实现，把有价值的理解保存为带源码依据的候选。

首次结构扫描不会直接得出完整业务模型。后续通过真实任务逐步补充；相关源码发生变化时，会提示复核已有理解。

结构扫描和历史整理可以在已有业务改动的仓库进行。**正式建立开发任务需要干净的 Git 基线**；已有改动由开发者决定如何保留或提交，工具不会自动 stash、reset 或 commit。

## 日常怎么用

在 Codex 中调用 `$project-dev`，后面直接描述需求，不需要每次复制一大段固定提示词。

| 你想做什么 | 可以这样说 |
| --- | --- |
| 实现需求 | `$project-dev 帮我实现这个需求：……` |
| 根据 PRD 开发 | `$project-dev 根据这份 PRD 实现需求，先梳理验收项和关联改动范围。` |
| 继续上次任务 | `$project-dev 继续当前仓库上次未完成的任务。` |
| 查看历史习惯 | `$project-dev 分析当前项目的历史习惯，给我查看报告。` |
| 纠正实现方式 | `这里应该复用现有封装，另外两个入口也要同步处理，原因是……` |

PRD 需要以当前 Codex 会话可读取的文本或附件提供。附件解析由 Codex 负责；本工具不提供独立的 Word、PDF 或图片解析服务。

一个需求通常按下面的顺序推进：

```text
理解需求与验收标准
  → 查询项目结构、已有实现、历史候选与已确认知识
  → 核对业务关系并建立关联改动清单
  → 修改代码，记录纠正原因
  → 执行项目验证，逐项检查遗漏
  → 保存任务结果和可供复用的经验候选
```

习惯和业务理解的候选需要结合当前代码核对。候选不会自动变成团队规则；确认共享知识需要显式审查。

## 更新到最新版本

在**工具源码目录**执行。保留首次连接时的 Node 路径和 workspace；若曾使用 `--codex`，最后一条命令也要加上同样的参数。

```bash
cd "$HOME/Tools/project-dev-agent"
git pull --ff-only && \
npm ci --ignore-scripts && \
npm run build && \
node dist/src/cli.js connect --workspace "/absolute/workspace" --apply
```

完成后，在 Codex 中重启 `project_dev` 连接并新建对话。**拉取源码和构建会更新服务代码，重新 connect 用于同步 Skill，重启连接才会让服务加载新代码。**

任一步失败都先处理错误再继续。`--ff-only` 会在本地与远端分支分叉时停止，不自动合并你的修改。出现 `SKILL_CONFLICT` 或 `MCP_CONFIG_CONFLICT` 时，先比较现有内容，避免覆盖自定义配置。

`v0.4.0` 标签保留首次团队验证的代码基线；`main` 持续接收修正。团队对比验证时，应记录所用提交，可用 `git rev-parse --short HEAD` 查看。

### 从旧安装包迁移到 Git 目录

如果之前已通过安装包连接，先使用**旧安装目录**中的 CLI 执行 `disconnect --workspace "/absolute/workspace" --apply`，再从新的 Git 目录执行上面的 `connect`。只移动文件目录会使旧连接仍指向原路径。

项目任务、历史候选和报告会保留，不需要重新复制到工具目录。

## 给团队使用

1. 为成员开通本私有仓库的访问权限。
2. 每人在自己的电脑克隆、构建，并连接自己的业务工作目录。
3. 使用相同版本和真实需求验证，记录需要纠正实现思路、遗漏关联改动以及额外操作的情况。
4. 将已审查、有复用价值的规则放入业务仓库的 `.project-dev/knowledge/`，通过团队原有 Git 审查流程共享。

各人的本地对话和未确认候选不会因使用同一个工具仓库而自动共享。个人试用无需先执行 `project init`；只有需要统一业务仓库配置、项目 Skill 和知识目录时，才使用该命令预览和写入团队配置。

## 技术实现与数据位置

| 组成 | 职责 |
| --- | --- |
| **Codex + Skill** | 当前 Codex 负责需求理解、语义分析、代码修改和验证；Skill 指导它按项目依据与关联清单执行。 |
| **本地 MCP 服务** | 使用 TypeScript、Node.js 和 MCP SDK，通过 STDIO 提供项目扫描、上下文查询、历史整理、任务和知识管理工具。 |
| **项目本地记录** | 使用文件保存索引、任务、候选和来源版本；无需部署独立后端。源码引用、文件哈希和修订号用于追溯与复核。 |

```text
业务仓库/
└── .project-dev/
    ├── project.yaml         # 可选的项目配置
    ├── knowledge/           # 经审查、可通过业务仓库共享的知识
    └── local/               # Git 本地忽略的个人记录
        ├── tasks/           # 任务、清单与验证证据
        ├── understanding/   # 结构索引、模块理解与 HTML 报告
        ├── history/         # 项目历史文本缓存、候选与 HTML 报告
        └── proposals/       # 待审查的经验草稿
```

首次个人接入按需建立 `local/`，不会要求生成或提交整套共享配置。用于分析的源码和历史片段会进入当前 Codex 会话上下文；本地存储不代表完全离线分析。这些个人记录不会由工具自动上传到本 GitHub 仓库。

## 当前能力边界

- **关联分析是辅助线索。** 当前主要提取 JS/TS、Vue、Svelte 等代码中的直接导入关系，不是完整 AST、调用图或跨系统业务影响分析；动态调用和其他语言关系仍需人工与 Codex 核对。
- **历史分析有来源范围。** 只覆盖本机可读取且能够归属当前项目的 Codex 对话文本，不等于全员历史；历史附件正文暂不解析。
- **业务理解逐步积累。** 从代码观察到的行为不等于已确认产品规则，后端不可见逻辑和业务歧义仍需确认。
- **清单与验证记录不保证实现正确。** Skill 是执行指导，不是强制拦截机制；真实项目的测试与代码审查仍然需要。
- **目前是本地工具。** 没有团队中央服务、插件市场自动安装或自动更新。workspace 模式要求业务仓库及 Git 元数据位于配置范围内，范围外的 worktree 不能直接使用该连接。

v0.4.0 已记录类型检查及 **89 项自动化测试通过**，并完成独立目录的依赖安装、构建和环境检查。测试证明相应机制可运行；减少多少纠偏、返工或遗漏，还需要通过真实开发需求验证。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| GitHub 提示 Repository not found | 检查账号是否已获私有仓库访问权限，以及 Git 使用的 SSH / HTTPS 身份是否正确。 |
| 找不到 `codex` 或出现 `CODEX_COMMAND_FAILED` | 检查 Codex CLI 是否可执行，必要时用 `--codex` 指定实际路径。 |
| Skill 或 MCP 工具没有出现 | 确认 `connect --apply` 成功，重启 `project_dev` 连接并新建对话；检查是否有旧的项目级 Skill。 |
| `PROJECT_OUTSIDE_WORKSPACE` | 检查当前业务仓库及其 Git 元数据是否位于配置的 workspace 内。 |
| `WORKTREE_DIRTY` | 保留已有改动，由开发者处理后再建立任务；不要为了通过检查而丢弃代码。 |
| `ACTIVE_TASK_EXISTS` | 先恢复当前仓库未完成的任务，确认是否与本次需求一致。 |
| `SKILL_CONFLICT` / `MCP_CONFIG_CONFLICT` | 比较已有配置和新版本，确认安装目录、Node 路径、workspace 与自定义修改；安装器不会覆盖不匹配内容。 |
| 报告显示未覆盖或未完成 | 根据报告检查排除项、扫描限制或待分析批次，继续相关步骤，不把部分结果当作全量完成。 |

## 断开连接

在原工具目录执行，workspace 与 `--codex` 参数保持和安装时一致：

```bash
node dist/src/cli.js disconnect --workspace "/absolute/workspace" --apply
```

这会移除匹配的 MCP 连接和未经自定义修改的已安装 Skill。项目任务、知识、报告、Git 本地忽略规则和工具目录会保留。

## 开发与详细文档

开发工具本身时，在本仓库执行：

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` 执行类型检查、构建和自动化测试。

仓库首页使用 Markdown，可直接在 GitHub 阅读。详细说明保留 HTML，**克隆后用本机浏览器打开对应文件**：

- [完整使用指南](guide.html)
- [安装与日常使用](docs/codex-setup.html)
- [项目结构与业务理解](docs/project-understanding.html)
- [历史习惯发现](docs/history-mining.html)
- [经验与知识审查](docs/knowledge-review.html)
- [真实需求试用](docs/pilot-guide.html)
- [验证记录与边界](docs/verification.html)

实现入口：[Skill](skills/project-dev/SKILL.md)、[CLI](src/cli.ts)、[MCP 服务](src/server.ts)。
