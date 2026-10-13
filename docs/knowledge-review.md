# 项目知识与经验审查

每条规则一个 Markdown 文件，以 YAML 元数据开头，正文包含 `## 规则` 和 `## 原因`。参考 `templates/knowledge.md`。模块名、路径和适用条件至少填写一种。路径支持字面前缀及 `*`、`**`、`?`；例如 `src/accounts` 包含子目录，`src/**/*.ts` 同时包含直接和嵌套的 TS 文件。

项目 `.project-dev/project.yaml` 指定知识目录、模块路径和排除项。模块和路径共同限制结果，关键词用于排序；自然语言适用条件仍由开发者或 Codex 核对。每份知识最多 32 KiB，整个目录最多 200 条、2 MB。坏 YAML、重复 ID、缺失目录和读取错误都会报告诊断；部分可用不等于完整扫描成功。

## 从纠正到复用

1. Codex 在任务 `corrections` 保存具体纠正、原因和来源，例如“只拦住新登录，旧会话仍可访问”。
2. `experience_propose` 引用这个 correction ID，写入 `.project-dev/local/proposals/`。草稿包含适用范围、规则、来源和待确认问题。
3. 同事核对推广范围、例外、事实依据，修订草稿，并在问题解决后将 `review_questions` 改为 `[]`。
4. 经明确授权的审查人执行命令，或按团队等效 Git 审查流程维护共享规则：

```bash
node /absolute/tool/dist/src/cli.js knowledge review --project /absolute/project --file .project-dev/local/proposals/exp-example.md --reviewer '实际审查人'
```

命令记录人和时间、保存本地来源的 SHA-256，并写入共享知识目录，原草稿保留。它不提交或推送。姓名字段不提供身份认证，团队仍需真实审查。MCP 没有确认规则的工具，Skill 要求先取得明确审查结论。

5. 检查差异并走团队 Git 流程。下一需求检索到规则后，先记录采用的 ID 和内容版本，再生成关联清单。

## 变化与停用

`candidate` 是草稿；`confirmed` 有审查记录；`needs_review` 保留此前来源但需复核；`disabled` 保留历史，检索不返回。

代码和文档引用采用仓库相对文件路径，可带 `:行号` 或 `#锚点`。当前按整个文件计算哈希，无关行变更也可能触发复核。外部 URL、符号链接、过大来源和缺失快照均不能视作已核验；工具不自动访问网络。

经验引用依赖人的确认，没有代码哈希能证明事实，应明确适用边界。源文件变化不会改写共享规则，只改变检索有效状态；重新核对后，对共享 Markdown 执行 `knowledge review` 更新快照。停用规则先明确改回候选再审查。用 Git 留下修订、停用及确认历史。

任务中已采用的版本作为历史保留；后续来源变化不抹掉当时依据，也不会自动判定旧任务应如何重做。
