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

## 生码规则如何进入任务记录

[默认生码规则](generation-rules.md)使用现有任务字段，不增加 `design`、`component_choice` 等 MCP 参数。

| 内容 | 保存位置 | 要求 |
| --- | --- | --- |
| 本次明确需求 | `task_open.requirement`、`acceptance_criteria` | 验收描述应能观察或核对；初始要求不用伪造为纠正 |
| 模块职责、设计模式取舍、组件选型 | 对应 `change_items.rationale` 和 `sources` | 写清选择与原因，引用实际源码、组件 API 或文档；无需另造设计文件 |
| 需要验收的生码约束 | `acceptance_criteria` | 只加入适用且具体的项，例如“订单金额计算不依赖 UI 和网络请求”；不机械复制五条口号 |
| 开发中新增、修订或纠正的要求 | `corrections`，同步调整验收项与清单 | 记录实际来源与原因，不编造会话 ID；保留原记录 ID 和历史修订 |
| 代码规则的实际审查 | 对应清单项或验收项的 `evidence` | `kind: code/manual`，引用具体文件并描述已核对的行为；不能当作自动测试结果 |
| 项目验证结果 | `validations` | 实际执行后记录命令和结果，保留失败与未运行状态 |

任务的原始 `requirement` 由 `task_open` 保存，`task_update` 不接受改写它。用户改变要求时，新增带来源的纠正记录，保留验收项 ID 并修订描述，使当前验收反映新要求。受影响的旧完成项先改为 `pending`，清除旧 `reviewed_by`、`review_snapshot` 和 `evidence`，再实际核验；不要把新描述和旧通过结论一起沿用。已记录的验证若需要重跑，设为 `not_run` 并清除旧证据与指纹。更新集合仍需完整回传，保留其他条目。

下面是结构示例，路径和选择理由均须替换为本次阅读得到的真实内容：

```json
{
  "id": "amount-calculation",
  "target_path": "src/orders/calculate.ts",
  "action": "modify",
  "requirement": "支持本次订单金额规则",
  "rationale": "金额计算独立于页面交互和请求；当前只有一种算法，使用纯函数，私有舍入辅助函数共置，无需策略层；公共函数与舍入依据配套中文注释。本项不涉及组件选型。",
  "sources": [{ "kind": "code", "reference": "src/orders/existing-calculation.ts" }],
  "status": "pending"
}
```

不适用的项在相应理由中说明，不伪造“通过”证据。已有清单项经核对确实不需处理时，可用 `skipped` 并附 `reviewed_by`、`skip_reason`；验收项没有 `skipped` 状态，需求变更应保留 ID、修订当前验收描述并重新核验。恢复旧任务沿用现有字段和记录，不为补齐新规则重建任务或刷新旧指纹。

## 知识与纠正

查询形状：`{ "query": "任务关键词", "paths": ["src/entry.js"], "modules": ["module-name"], "limit": 5 }`。未知模块名省略；同时提供的范围筛选需要全部满足。结果含 ID、文件、内容哈希 `version`、来源、`effective` 和适用条件。`include_unconfirmed: true` 会返回未生效的审查线索。不完整结果带有诊断，不能当作全量知识扫描。

修改来源文件前，用 `task_update` 保存已使用的确认知识：`knowledge_versions: [{ "id": "rule-id", "version": "returned-sha256" }]`，保留已有 ID。任务记录这些历史版本；来源变化后，当前查询可能要求重新审查。

经验草稿示例：`{ "task_id": "...", "correction_id": "existing-correction-id", "title": "可复用的经验标题", "type": "change_relation", "modules": ["module-name"], "paths": ["src"], "applicable_conditions": ["具体适用情境"], "rule": "拟采用的行为规则", "review_questions": ["需要同事核实哪些问题？"] }`。类型还包括 `code_convention` 和 `business_rule`。工具复制纠正记录的原因与来源，只生成本地草稿并返回相对路径，不确认或发布规则。


## 0.8：业务验收和效果统计

`task_check.data.quality` 返回关联线索、业务场景、规则分歧和现有检查脚本。`state` 为 `not_scanned/unavailable` 时不是检查通过。`index_state: needs_rescan` 先刷新索引。场景数量有限，检查 `truncated/models_truncated`，默认最多15个关联位置和10个业务场景；通过 `project_context {model_id, rule_ids}` 分批读取规则场景，再写入当前任务验收。

适用场景的 `business_check` 原样附在现有验收项：

```json
{"id":"freeze-boundary","description":"核对冻结状态成立及不成立时的编辑行为","status":"pending","business_check":{"model_id":"orders","rule_id":"editable","rule_fingerprint":"工具返回的64位哈希","scenario_id":"工具返回的场景ID"}}
```

上例哈希和 ID 是占位说明；必须采用工具实际返回值。完成时仍需审查者、证据和当前 `review_snapshot`。规则或来源变化后显示 `stale/needs_rule_review`，场景本身消失时通过 `obsolete_acceptance_ids` 提示；复核、修订验收后才能关闭，失败返回 `BUSINESS_CHECK_STALE`。普通已完成验收不会自动算作某条业务场景已覆盖。

收尾时在原工具加 `include_evaluation: true`，读取本项目至多100条任务统计；截断明确标识。`observed` 是当前记录数、纠正条目数、待验收与当前失败验证记录数，不是实际返工工时或历史交互总次数。

明确安排同需求对照时，可在 `task_open` 附 `evaluation: {"case_id":"real-case-1","variant":"baseline","sample":"real"}`；另一条使用 `variant: assisted`。元数据创建后不可改组。只有唯一、已完成、需求及验收描述一致的真实配对才比较纠正条目差异。`sample: fixture`、无对照、口径变化、重复样本和截断结果不产生真实改善结论。日常不要求填写该字段，也不自动伪造 baseline。


## 0.8.1：请求基础设施复用检查

创建任务时，服务自动捕获 `implementation_baseline`，记录已发现的项目请求入口；该字段不接收工具输入，也不能事后改写。`task_check.quality.reuse` 比较 Git 基线与本次底层 HTTP 新用法：已有封装时，业务模块新建 axios 客户端或直接使用底层请求会返回 `PROJECT_REUSE_REQUIRED`；即使其他清单完成，也不能直接关闭。旧任务缺少快照时按基线与当前索引补查，新写的客户端不能成为既有能力。覆盖不完整时返回 `PROJECT_REUSE_CONTEXT_REQUIRED`，不能声称复用审查通过。

必要例外由 Agent 在对应 `change_items` 中附：`reuse_exception: {capability: "http", reason: "具体缺口、已查扩展及验证理由", inspected_path: "实际统一入口", source_version: "current", sha256: "实际64位哈希", line: 1, quote: "该行的实际原文"}`。上例路径和哈希是占位说明；原文必须存在、哈希一致，清单项仍需 checked、审查者、证据与当前 review_snapshot。`source_version: baseline` 用于确实需要替换旧基础设施且当前原文已修改的情况，引用任务 Git 基线。

无项目封装时允许按需建立基础能力；既有底层调用未增加、原统一入口内部维护、类型导入与注释不算新增重复。检测是静态词法线索，不能保证覆盖动态调用、所有语言和语义等价的绕过方式；例外理由仍由执行者核实，不因引用格式有效就宣称架构正确。
