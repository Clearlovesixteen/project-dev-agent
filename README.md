# Project Dev Agent

接入 Codex 的项目开发工具包：检索项目惯例和业务约束，记录关联改动清单，把纠正经验保存为可审查的知识。入口是 Codex 中的 `project-dev` Skill，状态和检索由本地 STDIO MCP 服务提供。

当前 v0.1 已实现五个工具、项目初始化与命令行审查。核心工具不依赖某个业务项目、模型 API Key、数据库或向量服务。

| 工具 | 用途 |
| --- | --- |
| `knowledge_search` | 按模块、路径和关键词检索规则，返回来源、版本和复核提示 |
| `task_open` | 从干净 Git 基线建立任务和验收项 |
| `task_update` | 保存关联清单、核对证据、纠正理由和已使用的知识版本 |
| `task_check` | 比对清单与实际变化，报告待核对项、清单外文件和基线异常 |
| `experience_propose` | 从具体纠正生成候选草稿，保留适用范围和待确认点 |

## 快速开始

需要 Node.js 20.19+、npm、Git，以及支持本地 MCP 的 Codex 客户端。在工具目录执行：

```bash
npm ci --ignore-scripts
npm run check
node dist/src/cli.js doctor
```

`doctor` 检查 Node/Git 和 SDK 能否初始化；`codex_connection: not_checked` 表示它不连接 Codex 客户端。

没有业务项目也可以开始：

```bash
node dist/src/cli.js sample create --destination /tmp/account-agent-demo
node dist/src/cli.js project init --project /tmp/account-agent-demo
node dist/src/cli.js project init --project /tmp/account-agent-demo --apply
```

样例目标须尚不存在、父目录已存在，会创建独立 Git 仓库和初始提交。初始化先输出文件预览，`--apply` 写入配置、Skill、忽略规则和本机连接配置；保留已有内容，重复执行不会重复追加。

按正常 Git 流程处理初始化产生的变更，使工作树干净。然后将目标项目 `.project-dev/local/codex.toml` 中的配置接入 Codex，新建会话并调用：

```text
$project-dev 为账号增加 disabled 状态，禁用账号不能使用系统，查询展示正确状态。
```

详细步骤见 [Codex 接入](docs/codex-setup.md)。开发工作区另有独立 `account-agent-demo` 仓库，含三条明确标注为合成示例的知识。示例只展示机制，不作为业务效果证据。

## 项目数据

```text
.project-dev/
  project.yaml         # 知识目录、模块范围和排除路径
  knowledge/*.md       # Git 管理的共享知识
  local/               # Git 忽略的本机数据
    tasks/*.json       # 修订号、清单、证据、纠正记录
    proposals/*.md     # 尚未确认的经验草稿
    codex.toml         # 当前工作树对应的连接配置
    plugin/            # 包含当前工作树绑定的本地插件目录
```

知识有 `candidate/confirmed/needs_review/disabled` 状态。默认检索返回来源仍有效的已确认规则。代码和文档保存内容哈希，文件变化或缺失会提示复核；经验来源保留人的审查记录。规则适用条件仍需 Codex 或开发者结合当前任务判断。

模板见 [templates/knowledge.md](templates/knowledge.md)，经验审查见 [docs/knowledge-review.md](docs/knowledge-review.md)。第一批知识可从已有代码惯例、业务文档和同事已确认的经验中整理；工具不会自动归纳并确认整库业务规则。

## 验证与边界

```bash
npm run typecheck
npm test
npm run test:integration
```

测试覆盖关联待核对项、陈旧修订号、冲突基线、任务恢复、知识范围和来源变化、纠正复用、初始化幂等及真实 STDIO 客户端调用。实测状态见 [验证报告](docs/verification.md)。

同一工作树只允许一个活动任务。任务开始前须干净且已有提交；任务中的正常提交仍与原基线比较。关闭任务要求清单与验收有证据；中止保留历史。工具核对结构化记录与文件覆盖，无法独立证明业务正确，也无法发现所有未登记的业务关联。核对后若再次修改代码，需要重新审查相关证据。

检索使用范围筛选与关键词排序，尚未提供 AST 影响分析、向量语义搜索或多仓库联动。审查人字段记录来源，不提供身份认证。真实团队的纠偏、漏改和额外负担，需要试用后才能得出结论。

后续使用 [试用指南](docs/pilot-guide.md) 与 [分享提纲](docs/sharing-outline.md)。
