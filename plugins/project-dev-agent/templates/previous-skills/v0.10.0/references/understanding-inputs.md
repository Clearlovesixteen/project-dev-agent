# 精简、可追溯的业务建模

每次 MCP 调用都传 `project`（当前 Git 工作树绝对路径）。模型是有依据的候选，不是团队已批准的规则。用户仍只需描述需求；下面的记录、查询和修订由 Codex 完成。

## 先查相关内容

- `project_scan { project }` 刷新结构索引，重复扫描复用未变化的提取结果；不会重写业务规则或清除待复核状态。
- `project_context { project, query?, paths?, modules?, limit?, model_offset? }` 返回代码线索与模型。新版模型默认摘要，每页最多 5 个；显式业务关系可以带出一层关联模型，`match_reason: business_relation` 表示间接命中。关系是需要阅读代码的线索，不代表所有目标都要修改。
- 使用 `details_request` 加当前 `project` 获取详情。可再传 `rule_ids: ["edit"]`，只返回选中规则、关系和对应来源；适用条件、异常和待确认问题保留。`content_truncated` 表示摘要或部分内容，不能据此断言已经核对全部业务。
- `needs_rescan` 表示结构索引需刷新；`needs_review` 表示已有规则或关系需要核对。后者先看 `review_required`，读受影响源码，再局部修订；不要循环重扫或只换哈希。摘要中的待复核 ID 列表有截取，详情包含完整列表。

## 建模粒度与依据

按业务能力建模，保留对象与状态、流程、关键规则、异常和待确认问题。同一模型通过稳定规则 ID 复用概念；跨能力公共概念可独立成模型，通过 `target_model_id` 引用，避免复制整套规则。只有新信息能帮助后续开发时才记录，普通改动无需建立完整业务地图。

每条规则必须有 ID、职责、适用条件、异常条件和 `source_ids`，并区分：

| basis | 含义与要求 |
| --- | --- |
| `observed` | 当前代码已观察行为，至少有一条 `code` 来源；不能凭前端代码断言后端已经校验。 |
| `intended` | 需求预期行为，至少有一条 `document` 或 `task` 来源；可能尚未实现，不作为现有行为使用。 |
| `inferred` | 有来源但仍需核实的推断；影响本次实现且无法自行核对时才询问。 |

当前行为与新需求不同，应分别保留依据，并把差异纳入实现与验收；旧模型不能否决当前需求。例外暂未发现可写空数组，但不等于不存在例外；关键未知写入 `questions`。不要为填字段编造状态转换、业务规则、来源或人工确认。

来源在模型内按 ID 共用：

- 文件来源：`{ id, kind: "code" | "document", path, sha256, line, quote }`。路径必须已索引并包含于 `related_paths`，Markdown 作为文档、程序源码作为代码，HTML/XML/配置按实际用途标注；引用行号、原文和当前文件哈希均需匹配。
- 任务来源：`{ id, kind: "task", task_id, correction_id?, quote }`。引用本项目已保存的原始需求，或指定纠正记录的 `description + "\n" + rationale`。工具校验原文并保存其哈希；没有 `correction_id` 时引用原始需求。不能引用其他项目或助手虚构的用户确认。这里是任务中记录的要求，不是身份认证或团队审批。
- 未落入上述可核对来源的 PRD 附件内容，先用于当前需求分析；需要长期记录时引用本次已保存的任务要求。不要为了建模要求用户另写说明文件。

## 新建与旧模型迁移

新模型使用 `schema_version: 2`、`expected_revision: 0`。下面展示字段组合，文件、原文和哈希须从当前项目读取后替换，不能直接照抄：

```json
{
  "project": "/absolute/repository",
  "schema_version": 2,
  "scan_id": "填写当前扫描的 64 位哈希",
  "id": "order-editing",
  "expected_revision": 0,
  "revision_reason": "核对订单编辑入口与状态定义",
  "module": "orders",
  "title": "订单编辑条件",
  "scope": ["src/orders.ts"],
  "summary": "记录前端订单编辑限制，后端规则待核实。",
  "entities": [{"name": "订单状态", "meaning": "决定页面可用操作的业务状态"}],
  "flows": [{"name": "编辑入口", "steps": ["读取订单状态", "判断是否允许编辑"]}],
  "rules": [{"id": "edit", "description": "冻结订单禁止编辑", "responsibility": "frontend", "basis": "observed", "conditions": ["订单处于冻结状态"], "exceptions": [], "source_ids": ["editable-code"]}],
  "sources": [{"id": "editable-code", "kind": "code", "path": "src/orders.ts", "sha256": "填写当前文件的 64 位哈希", "line": 1, "quote": "填写这一行开始的准确原文"}],
  "related_paths": ["src/orders.ts"],
  "relations": [],
  "questions": ["后端是否也限制冻结订单的修改？"]
}
```

业务关系结构：`{ id, rule_ids, kind, target_path, reason, source_ids, target_model_id? }`。`kind` 为 `enforced_by`（规则实施位置）、`used_by`（使用位置）或 `depends_on`（依赖位置）。目标文件需索引且属于 `related_paths`；引用的模型需存在。保存前先阅读目标实现，再说明关系依据。工具保存目标文件版本及被引用模型的修订号；它们变化、所关联规则变化或依据过期，都会提示复核关系。

旧模型继续可读。首次需要增强或修订某个旧模型时，先读取完整内容，核对后补齐每条规则的来源、条件和例外，再用相同 ID、最新 `expected_revision` 和 `schema_version: 2` 完整迁移。保留有效发现及未知问题，旧修订不可变；不能批量自动补造规则依据。旧版没有明确规则时，先按实际需求读懂代码，再提炼有依据的规则。

## 已有新版模型只做局部修订

```json
{
  "project": "/absolute/repository",
  "schema_version": 2,
  "id": "order-editing",
  "scan_id": "当前扫描哈希",
  "expected_revision": 1,
  "revision_reason": "用户增加管理员例外，已核对相关实现",
  "patch": {
    "upsert_sources": [],
    "upsert_rules": [],
    "upsert_relations": []
  }
}
```

示例空数组必须换成实际更新项；空修订会被拒绝。只提交本次实际核对的完整条目，省略的条目保留：

- `upsert_rules` / `remove_rule_ids`：按稳定 ID 更新或删除规则。
- `upsert_relations` / `remove_relation_ids`：更新或删除业务关系。
- `upsert_sources` / `remove_source_ids`：更新或删除来源；被规则或关系引用的来源不能直接删除。
- `metadata`：只包含需修订的 `module/title/scope/summary/entities/flows/related_paths/questions`。其中数组是该字段的完整新值，先读旧值再合并，不能丢失既有例外或问题。

仅更新来源或摘要不会刷新规则。规则引用同一个变化来源时，未实际复核的规则继续显示 `needs_review`；其他文件过期也不妨碍修订本次已核实的条目。调整了规则，相关关系可能需要一并核对；不能仅为了让状态变绿而提交全部规则和关系。

模型更新使用预期修订号并保留不可变历史；冲突时重新读取、合并再试，不能覆盖他人修订。单模型最多 20 条规则、30 条关系、30 条来源，保存上限 64 KiB；超限按业务能力拆分，不能删掉必要异常来凑长度。标题、说明默认中文，原文引用不翻译。结构化内容、依据和异常均由 Agent 维护，用户无需填写这些参数。

CLI 可用 `project context --project ... --model-id ... --rule-id edit` 查询；多个规则重复传 `--rule-id`。记录与修订继续使用 `model record --project ... --file ...`。扫描或模型不可用时说明限制，继续依据当前源码完成不受影响的工作。


## 0.8：分歧、重复与增量扫描

- `rules[].assertion` 可选，例如 `{ "subject": "冻结订单", "property": "允许编辑", "value": "false" }`。它是 Agent 对原文结论的提炼，不代替 `description`、条件、异常和逐条来源。
- `project_context` 及记录结果的 `model_audit` 返回范围重叠、职责/条件/异常一致时的 `rule_conflict`、`behavior_divergence`、`duplicate_rule` 和术语差异。包含修订及规则详情请求；结果受数量和容量限制，`truncated` 必须保留。断言缺失、近义词、条件歧义仍需 Codex 阅读来源核实。
- `duplicate_rule.canonical` 是稳定的引用建议，不代表被批准的权威模型。优先复用业务关系；必要整理使用原有 patch，核对意义、保留来源，不自动删除模型。
- `impact` 根据双向直接导入、显式业务关系及共享标识符返回待核对位置。同名标识符不证明属于同一业务对象。
- 扫描新增 `content_reused/read_files/read_bytes` 统计。路径与纳秒文件元数据未变化时复用结构解析，新增、删除、改名和别名仍重新解析关系；缓存命中仍核验路径边界。业务规则新鲜度继续读取实际来源，不由扫描缓存代替。


## 0.10：业务规则变更草案与发布

保持当前模型与任务预期分开。通过 `task_update.business_deltas` 追加草案：`id/model_id/base_revision/operation:add|modify|remove/rule_id/reason/acceptance_ids/sources`；修改和删除另填从当前模型得到的 `expected_rule_fingerprint`。新增/修改附 `proposed_rule`（同规则ID、basis:intended、条件/例外/需求 source_ids）；删除不填预期规则。需求来源只使用真实文档或本项目任务原文，旧代码前镜像由服务读取。最多20条草案历史。

先补齐足够的 pending 验收项，保存草案后从 `task_check.quality.business_delta.items[].scenarios` 获取正常、条件边界、例外或退役场景的 `business_delta_check`，绑定原验收。正常/边界/例外并不自动证明预期正确，须结合需求实际核验。预期草案不会直接改当前模型，旧规则和无关证据保持原样。

完成当前快照的关联验收和真实检查后，调用 `project_model_apply`，参数为 `task_id/expected_revision/delta_id/observed_rule/sources`。新增/修改须独立提交 `basis:observed` 且语义与本次预期一致的规则，以及实际核对的当前代码来源；删除不填 observed_rule，但仍须当前代码支持的停用证据。工具回传新任务修订号与服务端发布回执。原 `project_model_record` 仍用于建立模型和一般知识维护，不用于绕过草案发布保护。

规则冲突时读取最新模型；修改草案用新ID及 `supersedes_id`，关联验收重开。未完成发布先恢复，不覆盖旧记录。已经发布但代码再次变化时，重扫来源、重新核验场景与真实检查，提交当前代码依据追加复核回执；旧回执继续保留。需求发生新变化时也保留此前发布的事实，按当前规则重新建立明确的后继草案。

发布采用任务锁→模型锁的固定顺序，模型修订和日志可恢复重试；相同发布不重复应用。模型发布失败或任务记录保存失败时，按工具返回状态继续，不宣称完成。关闭时核对当前规则、需求来源、场景验收及回执快照；删除最后规则、未处理关系引用等操作要求先明确处置，不隐式清理整份模型。
