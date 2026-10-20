# 任务工具输入

工具包括 `project_prepare`、`task_open`、`task_update`、`task_check`、`knowledge_search` 和 `experience_propose`，具体参数以工具声明为准。以下示例展示数据形状，应按真实项目填写，不能当作业务需求清单。自然语言字段默认使用中文，标识和引用原文保持不变。

工作目录模式下，每次调用都要补充 `"project": "/absolute/current/repository"`。先用 `project_prepare` 检查状态；授权开发时传 `"apply": true`，首次插件使用会初始化当前仓库并准备本地忽略规则。返回 `state_ignored`、`worktree_clean`、`ready_to_open` 和 `active_task`。准备过程保留未提交改动，不会自动让脏工作树满足建任务条件。

新对话或进程重启后，用仅包含 `project` 的 `task_check` 恢复唯一活跃任务；没有任务时返回 `NO_ACTIVE_TASK`。更新使用恢复记录中的最新修订号。指定任务 ID 也可读取已关闭或中止的历史记录。同一任务的所有调用必须使用同一个项目。

创建任务示例：

```json
{
  "requirement": "实现用户提出的需求",
  "acceptance_criteria": [
    { "id": "behavior", "description": "填写可观察、可验证的预期结果" }
  ]
}
```

使用返回的 `id` 和 `revision` 更新：

```json
{
  "task_id": "returned-task-id",
  "expected_revision": 0,
  "change_items": [{
    "id": "entry-point",
    "target_path": "src/entry.js",
    "action": "modify",
    "requirement": "调整此入口的行为",
    "rationale": "说明该入口为什么受到本次需求影响",
    "sources": [{ "kind": "code", "reference": "src/entry.js" }],
    "status": "pending"
  }]
}
```

来源类型为 `code/document/experience`，必须提供 `reference`，可用 `description` 补充说明。已检查项需填写 `reviewed_by` 和非空 `evidence`；证据包含 `kind: code/test/manual`、`reference`、`summary`。跳过项需填写 `reviewed_by` 和 `skip_reason`。

验收记录包含 `id`、`description`、`status: pending/checked`、`reviewed_by`、`evidence`。验证记录包含 `id`、`description`、`outcome: passed/failed/not_run`、`evidence`；已执行验证必须有证据。纠正记录包含 `id`、`description`、`rationale`、`sources`。

仅更新发生变化的集合，但每个集合必须传完整内容并保留已有 ID。通过 `task_check` 读取最新记录；`pending_acceptance` 和 `pending_items` 是未完成项的 ID。每次成功更新会返回新修订号。存储繁忙或版本冲突时，先读最新状态再决定是否重试。

提交已审查项、已执行验证或已检查验收项时，还需要顶层 `review_snapshot`：在实际审查/验证前调用 `task_check` 获取指纹，在该代码版本上核验，再用同一个指纹提交记录。服务为各项保存对应指纹；回传单项的 `review_snapshot` 不能刷新旧证据。`REVIEW_SNAPSHOT_CHANGED` 表示核验期间代码已变化，需重新检查；不要获取新指纹后直接复用旧测试结果。提交 `pending`、`not_run` 或普通纠正记录无需指纹。

`task_check.stale_evidence` 按改动项、验收项和验证项列出过期证据。已检查记录对应的代码变化后，检查返回 `REVIEW_STALE` 并阻止关闭。重新核验后，提交完整集合、新指纹和 `reviewed_ids`，例如 `"reviewed_ids": { "change_items": ["entry-point"], "validations": ["unit-tests"] }`。只列出本次实际复核的 ID；未列出的已有完成项即使随完整列表回传，也保留原指纹。已有完成项的内容变化同样需要显式复核；新完成项仍可直接带指纹保存。重复、不存在、待处理的 ID，或未同时提交对应集合，都会被拒绝。

旧版本记录可读取和中止，缺少指纹的完成记录需通过 `reviewed_ids` 显式复核才能关闭。指纹覆盖 Git 基线、有效改动和未跟踪文件，未覆盖被 Git 忽略的依赖或外部服务状态。

结束前用 `task_check` 检查任务。`structurally_reviewed` 只表示记录与文件覆盖符合结构要求，不独立验证业务正确性；完整任务位于 `recorded_task`。工作完成后用最新修订号、有效记录和 `phase: closed` 关闭。停止工作使用 `phase: aborted` 并填写 `abort_reason`。结束的任务是只读历史，后续改动需从干净基线另建任务。

## 知识与纠正

查询形状：`{ "query": "任务关键词", "paths": ["src/entry.js"], "modules": ["module-name"], "limit": 5 }`。未知模块名省略；同时提供的范围筛选需要全部满足。结果含 ID、文件、内容哈希 `version`、来源、`effective` 和适用条件。`include_unconfirmed: true` 会返回未生效的审查线索。不完整结果带有诊断，不能当作全量知识扫描。

修改来源文件前，用 `task_update` 保存已使用的确认知识：`knowledge_versions: [{ "id": "rule-id", "version": "returned-sha256" }]`，保留已有 ID。任务记录这些历史版本；来源变化后，当前查询可能要求重新审查。

经验草稿示例：`{ "task_id": "...", "correction_id": "existing-correction-id", "title": "可复用的经验标题", "type": "change_relation", "modules": ["module-name"], "paths": ["src"], "applicable_conditions": ["具体适用情境"], "rule": "拟采用的行为规则", "review_questions": ["需要同事核实哪些问题？"] }`。类型还包括 `code_convention` 和 `business_rule`。工具复制纠正记录的原因与来源，只生成本地草稿并返回相对路径，不确认或发布规则。
