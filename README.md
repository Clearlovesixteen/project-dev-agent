# Project Dev Agent

**让 Codex 在改代码前了解项目惯例、业务背景和相关改动范围，并把开发中的纠正经验留给下一次任务。**

这是接入 Codex 的开发辅助工具，适合已经用 Codex 修改项目、但仍需要反复纠正实现思路的开发者。它可以用于不同业务项目，不绑定某一个系统。

当前版本：**v0.5.0，供个人使用和小范围团队验证**。通过私有 GitHub Marketplace 分发原生 Codex 插件，运行代码和依赖已打包。同事无需克隆源码、运行 npm 或手动同步 Skill。

## 它能帮你做什么

| 常见问题 | 工具如何帮助 |
| --- | --- |
| Codex 不熟悉项目的代码习惯 | 建立项目结构索引，寻找同类实现、公共组件和已有封装，提供可核对的参考路径。 |
| 每次都要重新解释业务背景 | 围绕具体需求整理术语、流程和模块职责，保存源码依据，后续任务可以检索复用。 |
| 只修改当前文件，遗漏其他入口 | 结合直接引用、使用方和业务关系建立关联改动清单，结束前逐项检查。 |
| 以前纠正过的问题又出现 | 分析本机属于该项目的 Codex 历史对话，提取带原话来源的习惯候选和业务纠正。 |
| 换个对话就丢失开发进度 | 保存任务、验收项、关联清单和验证记录，在同一仓库恢复未完成的任务。 |

例如，修改一个订单状态的展示时，Agent 会先查找已有状态定义和展示组件，再核对列表、详情、筛选项及测试是否涉及这次变化。需要同步修改的地方和只需验证的地方都会进入清单；实际范围仍需结合当前代码判断。

## 安装前准备

- **Node.js 20.19+ 和 Git**，两者应能被 Codex 进程找到。插件已包含 JavaScript 依赖，但不包含 Node 本身。
- 已登录 Codex，CLI 支持 `codex plugin` 命令。如果提示未知命令，请先更新 Codex。
- 本私有 GitHub 仓库的访问权限；SSH 安装使用本机已配置的 GitHub SSH 身份。
- 一个已有提交的业务 Git 仓库，或包含多个 Git 仓库的工作目录。

无需额外模型 API Key、数据库或向量服务。语义分析使用当前 Codex 会话及其额度。

## 首次安装：只做一次

### 1. 添加插件源并安装

```bash
codex plugin marketplace add git@github.com:Clearlovesixteen/project-dev-agent.git --ref main
codex plugin add project-dev-agent@project-dev-team
```

第一条把私有 GitHub 仓库登记为插件源；第二条安装其中的插件。下载、版本缓存和启用状态由 Codex 管理。**不用把工具仓库克隆到自己的工作目录，也不用执行 npm install。**

若团队使用 HTTPS 认证，可把第一条的仓库地址替换为 `https://github.com/Clearlovesixteen/project-dev-agent.git`。连接 GitHub 插件账号和本机 Git 的 SSH/HTTPS 认证是两件事，本次下载使用后者。

如果终端找不到 `codex`，可以使用桌面应用内已有的 CLI 路径。部分 macOS 安装可执行：

```bash
"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" plugin marketplace add git@github.com:Clearlovesixteen/project-dev-agent.git --ref main
"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" plugin add project-dev-agent@project-dev-team
```

以实际安装位置为准；后文命令中的 `codex` 同样替换为这个路径。无需为安装修改全局 PATH。

### 2. 选择自己的项目范围

安装后重新打开 Codex，并在业务仓库新建对话。输入一次：

```text
$project-dev-setup 把工作目录设为 /absolute/workspace，接入当前项目。
```

`/absolute/workspace` 必须替换成你自己的现有绝对路径，可以是单个仓库，也可以是包含多个仓库的父目录。无需使用作者电脑的路径。

引导会检查插件版本，预览并保存你选定的目录，然后准备当前仓库。个人设置保存在 `${CODEX_HOME:-~/.codex}/project-dev-agent/settings.json`，独立于插件版本缓存。后续升级继续使用它。

### 3. 确认可以调用

```text
$project-dev 接入当前项目，生成项目理解报告。
```

看到 `project_prepare`、`project_scan` 等实际工具调用和返回的报告路径，说明当前会话接入成功。只看到“已安装”说明安装完成，不等于当前对话已加载工具；工具未出现时，重新启动 Codex 并新建对话。

插件包含三个 Skill：日常开发 `project-dev`、首次配置 `project-dev-setup`、版本更新 `project-dev-update`。原生安装不会再向全局 Skill 目录手动复制文件。

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

在 Codex 里说：

```text
$project-dev-update 更新 Project Dev Agent 到最新版。
```

它会调用 Codex 原生插件管理器刷新配置好的插件源，并核对安装版本。也可以直接执行：

```bash
codex plugin marketplace upgrade project-dev-team
codex plugin list --json
```

已实测：刷新 Git 插件源会更新已启用插件的版本缓存。更新后**新建对话或重启 Codex**，使 MCP 进程和 Skill 加载新版；运行中的旧对话不会自动切换。更新前先完成或保存当前开发任务。

工作目录配置、业务仓库里的任务、历史候选和报告会保留。发布者维护源码并提交新的预构建版本，同事只刷新插件源。当前没有额外的本地管理页面。

**本版本验证的是原生插件安装和刷新机制。** 尚未验证所有客户端的“更新”按钮位置，也不承诺后台定时更新或旧会话热更新。支持的客户端可以通过自己的插件界面管理启用和卸载；没有相应入口时使用上面的已验证命令。

`main` 是更新通道；`v0.5.0` 是固定的验证基线。跟随 `main` 才能持续收到新版本；固定到标签的安装只会保留对应版本。

### 从 v0.4 手动连接迁移

若之前通过源码目录或安装包运行过 `connect`，先在**原安装目录**执行下面的命令。workspace 和 `--codex` 参数保持与旧连接一致：

```bash
node dist/src/cli.js disconnect --workspace "/absolute/workspace" --apply
```

它只移除匹配的旧 MCP 连接和未修改的全局 Skill，保留业务项目记录。然后按本文安装原生插件，并设置相同的 workspace。出现自定义 Skill 或连接冲突时先核对，不要删除不相关的配置。业务仓库若还放有旧版 `.agents/skills/project-dev` 或 `.codex/config.toml` 连接，需要单独检查，避免重复加载。

## 给团队使用

1. 为成员开通本私有仓库的访问权限。
2. 每人在自己的 Codex 添加同一个插件源、安装插件，首次选择自己的业务工作目录。
3. 使用相同版本和真实需求验证，记录需要纠正实现思路、遗漏关联改动以及额外操作的情况。
4. 将已审查、有复用价值的规则放入业务仓库的 `.project-dev/knowledge/`，通过团队原有 Git 审查流程共享。

各人的本地对话和未确认候选不会因使用同一个插件源而自动共享。插件用户无需执行旧版 `connect` 或 `project init`；后者属于源码模式，会写入项目级 Skill 和 MCP 连接，可能造成重复加载。

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
- **插件在本机运行。** GitHub 用于分发工具版本，没有团队中央数据服务。业务仓库及 Git 元数据必须位于配置的 workspace 内，范围外的 worktree 需要正确的目录配置。

v0.5.0 的验证覆盖预构建包独立运行、未配置启动、工作目录隔离、设置并发保护，以及 Codex 原生插件安装和跨版本刷新。完整结果见 [验证记录](docs/verification.html)。测试证明相应机制可运行；减少多少纠偏、返工或遗漏，还需要通过真实需求与同事验证。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| GitHub 提示 Repository not found | 检查账号是否已获私有仓库访问权限，以及 Git 使用的 SSH / HTTPS 身份是否正确。 |
| 找不到 `codex` 或提示未知 `plugin` 命令 | 使用实际 Codex CLI 路径，并检查 Codex 版本是否支持原生插件命令。 |
| Skill 或 MCP 工具没有出现 | 确认原生插件已安装并启用，Node 与 Git 可用；重启 Codex 并新建对话，检查旧连接或项目级 Skill 是否重复。 |
| `PLUGIN_NOT_CONFIGURED` | 运行 `project-dev-setup` 选择本机工作目录。 |
| 更新后仍显示旧运行版本 | 区分安装版本与当前进程版本；更新后重启 Codex 并新建对话。 |
| `PROJECT_OUTSIDE_WORKSPACE` | 检查当前业务仓库及其 Git 元数据是否位于配置的 workspace 内。 |
| `WORKTREE_DIRTY` | 保留已有改动，由开发者处理后再建立任务；不要为了通过检查而丢弃代码。 |
| `ACTIVE_TASK_EXISTS` | 先恢复当前仓库未完成的任务，确认是否与本次需求一致。 |
| `SKILL_CONFLICT` / `MCP_CONFIG_CONFLICT` | 比较已有配置和新版本，确认安装目录、Node 路径、workspace 与自定义修改；安装器不会覆盖不匹配内容。 |
| 报告显示未覆盖或未完成 | 根据报告检查排除项、扫描限制或待分析批次，继续相关步骤，不把部分结果当作全量完成。 |

## 卸载插件

```bash
codex plugin remove project-dev-agent@project-dev-team
```

也可使用 Codex 插件界面的卸载入口。个人 workspace 设置和业务仓库里的任务、知识与报告位于插件缓存之外，会继续保留。重新安装可复用这些数据；如需删除数据，请先核对范围和备份。

## 开发与详细文档

开发工具本身时，在本仓库执行：

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` 执行类型检查、源码构建、插件打包和自动化测试。只修改源码不会向同事发布新版；发布前需要统一修改 `package.json`、锁文件、`plugin.json` 和 `src/version.ts` 的版本，重新构建并提交 `plugins/project-dev-agent/`。完整发布步骤见 [插件发布与维护](docs/plugin-release.html)。

仓库首页使用 Markdown，可直接在 GitHub 阅读。详细说明保留 HTML，**克隆后用本机浏览器打开对应文件**：

- [完整使用指南](guide.html)
- [安装与日常使用](docs/codex-setup.html)
- [插件发布与维护](docs/plugin-release.html)
- [项目结构与业务理解](docs/project-understanding.html)
- [历史习惯发现](docs/history-mining.html)
- [经验与知识审查](docs/knowledge-review.html)
- [真实需求试用](docs/pilot-guide.html)
- [验证记录与边界](docs/verification.html)

实现入口：[Skill](skills/project-dev/SKILL.md)、[CLI](src/cli.ts)、[MCP 服务](src/server.ts)。
