# 精简、可追溯的业务建模

## 结构化业务任务

当 `plugin_status.capabilities.business_model_writes` 为 `true` 且需求新增或改变有明确条件的业务行为时，优先沿用此闭环。纯工程或版式任务按原流程核对。已有 PRD/SDD 和项目测试直接承接，以下记录由 Agent 维护。

1. **取原文和代码。** 按原流程保存 `spec_input`、`requirement_sources` 和 `implementation_basis`。通过 `project_context` 读取相关模型、关联入口和复用线索，实际阅读代码。需要消解显式导入别名时查询 `code_locations:[{path,symbol}]`，使用返回的声明文件与符号；检查 `state` 与 `trace`。动态、通配和歧义位置需人工核对。库组件、项目组件、自己实现依次核对，新增共享封装须说明依据。
2. **保存当前规则和预期。** `schema_version:3` 的规则可附 `semantics`（`subject`、`action`、`when`、`expected`、`source_ids`、`cases`、`preserves`）与 `bindings`（`id,path,symbol,role,source_ids`）。`when` 使用 `all/any/not` 或 `field,op,value`；事实以点分字段为键。用真实条件分别准备允许、拒绝、例外及保留行为。绑定指向真实声明或具体文件，并附该文件原文依据。导入声明使用 `import:模块标识`，例如 `import:./request.js`。有旧模型时从详情读取 `rule_fingerprint`。新业务以 `operation:add`、`base_revision:0`、`new_model` 保存首条预期规则及计划位置，待新增的绑定传 `planned:true`。附件可通过 `kind:task,task_id,requirement_source_id,quote` 引用本项目已保存的文本资料。
3. **开工前固定范围。** 用 `task_open.business_model_policy:1` 建立增强任务。草案保存后，从 `task_check.quality.business_delta` 取结构化场景和 `business_delta_check`，挂到原验收项。用 `task_update.business_plan` 一次保存 `input_items`（原文、分类、验收）、`rules`（模型、规则、草案 ID）、`decisions`（每个代码绑定的 `modify/verify/protect/not_applicable`）、`related_checks`（没有绑定的关联只读入口）、`scenarios`（规则 `case_id` 或 `preserve_id`、验收、检查、测试文件、测试名）和必要的 `supporting_changes`。行为或约束应关联实际测试，设计条目对应实现依据。未决条目标为 `unresolved`，保留其来源。只修改确定的位置。遇到新影响先读代码，扩充未改位置的计划后继续。需要修订已改位置时，先处理本轮越界差异并重新核验，保留接入前已有改动。
4. **跑命名场景。** 优先复用实际覆盖预期的项目测试。首版结构化场景支持 Node 内置测试，使用 `validation_plan.checks` 中的 `command:"node", args:["--test","test/behavior.test.mjs"], behavior_report:"node-test"`，加入对应 `acceptance_ids`。通过现有 `validation run` 从原终端执行。其他项目测试照常运行，并明确其报告粒度。跳过、待完成、重名、无运行事件或过期结果保持待核验。
5. **核对和回写。** 查看 `task_check.quality.business_plan` 的 `issues`、`boundary.issues` 和 `scenarios`，复核本轮代码、关联入口和测试断言。准备新的源码原文、当前索引与真实代码绑定，再调用 `project_model_apply` 回写 observed 规则，按原流程关闭任务。运行结果通过只证明对应测试执行；实际业务语义由当前需求、代码和断言共同核对。

每次 MCP 调用都传 `project`（当前 Git 工作树绝对路径）。模型是有依据的候选，不是团队已批准的规则。用户仍只需描述需求；下面的记录、查询和修订由 Codex 完成。

## 仓库模型与当前工作树

本节适用于 `0.14.0`。升级后可用 `plugin_status` 核对当前会话加载的版本。

默认 `projects` 模式通过当前仓库的 `project_prepare(apply:true)` 登记；状态查询不登记，切换仓库无需更换全局目录。严格 `workspace` 范围仍可选。不同仓库各自保存模型；同一 Git common-dir 的工作树共享该公共目录下的 `project-dev-agent/`。结构扫描、任务、历史及验证仍分别属于各自工作树，不能共享任务基线或以另一工作树的测试代替当前验收。

`project_context` 和 `knowledge_search` 优先返回与当前源码唯一匹配的共享版本。遇到歧义时用 `model_snapshot_id` 查看历史候选；人工核对后以 `base_snapshot_id` 及 `reviewed_snapshot_ids` 记录修订来源，携带当前 `knowledge_view_token`。修订号用于并发校验和追溯，不代表跨分支的适用顺序。来源保留仓库身份、来源工作树、提交与证据版本；查询仍读取当前工作树源码核对哈希、原文和代码绑定。分支不同本身不等于失效，提交相同也不证明未提交改动一致。`needs_review` 是当前证据需要核对，不能解释成模型不存在，也不能靠重新扫描或换哈希宣告适用。

- 需要复核时，从详细 `project_context.project_knowledge.rule_reviews.items` 获取规则、路径、符号线索、关联场景和两个版本的指纹。相同工作树再次读取同一变化会得到相同 `review_id`。收尾时优先查看 `task_check.quality.business_plan.advisory.rule_reviews.current_task`。索引按当前证据派生，来源恢复或修订核验后重新计算。
- 整合多个已核对的快照时，服务沿父链寻找共同基线，再按规则、关系及场景 ID 合入独立变更。出现 `PROJECT_MODEL_MERGE_CONFLICT` 时，沿错误中的条目核对各候选和当前代码，在 patch 中明确提交选择。

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
- 任务来源：`{ id, kind: "task", task_id, correction_id?, quote }`。引用当前工作树已保存的原始需求，或指定纠正记录的 `description + "\n" + rationale`。工具校验原文并保存其哈希；没有 `correction_id` 时引用原始需求。仓库共享模型保留经核验的受限任务原文快照及来源身份，供其他 linked worktree 读取；不要求把任务记录搬到共享目录，也不依赖另一工作树的任务存储来重建原文。不能引用其他仓库或助手虚构的用户确认。这里是任务中记录的要求，不是身份认证或团队审批。
- 未落入上述可核对来源的 PRD 附件内容，先用于当前需求分析；需要长期记录时引用本次已保存的任务要求。不要为了建模要求用户另写说明文件。

## 新建与旧模型迁移

下面是兼容流程的 `schema_version: 2` 示例，`expected_revision: 0` 表示新建。增强流程使用上面的 v3 结构。文件、原文和哈希从当前项目读取后填写。

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

v1 模型按需完整迁移到 v2 或 v3，沿用 ID 和最新 `expected_revision`。v2 增强到 v3 时用 `patch` 补齐本次相关规则的结构化条件与代码绑定。保留旧修订、其余规则和待确认问题。旧版缺少规则时，先读相关实际代码，再提炼有依据的规则。

从工作树 `.project-dev/local/understanding/` 迁入仓库侧车时保留旧模型和来源。多个工作树存在同 ID 的不同内容，或中心模型已被其他写入修订时，保留冲突候选及双方版本供人工核对，不按文件时间、较大修订号或所在分支自动覆盖。先核对当前源码和规则条件，明确候选取舍后再使用实际修订号更新；迁移不自动合并代码或业务规则。

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
- 修改现有规则时保留原有 cases 和 preserves。规格明确要求删除或改名时，随 patch 或业务草案提交 `scenario_retirements`，每项填写 `rule_id`、`kind`（case 或 preserve）、原 `id`、`reason` 和 `source_id`；改名另填新条目的 `replacement_id`。业务草案的来源应定位到本次规格或任务原文，并为退役项单独绑定验收。
- `upsert_relations` / `remove_relation_ids`：更新或删除业务关系。
- `upsert_sources` / `remove_source_ids`：更新或删除来源；被规则或关系引用的来源不能直接删除。
- `metadata`：只包含需修订的 `module/title/scope/summary/entities/flows/related_paths/questions`。其中数组是该字段的完整新值，先读旧值再合并，不能丢失既有例外或问题。

仅更新来源或摘要不会刷新规则。规则引用同一个变化来源时，未实际复核的规则继续显示 `needs_review`；其他文件过期也不妨碍修订本次已核实的条目。调整了规则，相关关系可能需要一并核对；不能仅为了让状态变绿而提交全部规则和关系。

模型更新使用预期修订号、锁和不可变历史。修订冲突时保留候选，重新读取双方依据并人工核对后再试，不能自动合并规则或覆盖他人修订；读取最新修订不会刷新当前分支证据。单模型最多 20 条规则、30 条关系、30 条来源，保存上限 64 KiB；超限按业务能力拆分，不能删掉必要异常来凑长度。标题、说明默认中文，原文引用不翻译。结构化内容、依据和异常均由 Agent 维护，用户无需填写这些参数。

项目模式下，服务补充 `repository_key` 与 `origin`（工作树、分支、提交及 Git 身份），任务来源另补 `snapshot_id`。这些字段用于追溯，不能由 Agent 伪造快照绕过当前任务校验。查询的 `model_storage.root` 是共享模型基目录；`model_migration.required` 为 true 时先扫描当前工作树。若 `model_migration.conflicts` 非空，读取对应候选并人工核对后，在 `project_model_record` 中附 `resolved_migration_ids`，与本次 patch 或旧模型完整升级一起记录处理结果。不能仅为消除提醒批量填写未审查 ID。普通查询不执行模型迁移。

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


## 0.11：业务影响必须进入原有任务流程

新任务用 business_assessment 说明是否改变业务规则。changed 绑定本项目新版模型与当前有效草案；unchanged 写出实际不改变的对象、状态或操作；unknown 记录关键未知，不能直接关闭。工程复用、目录和代码习惯归实现依据或纠正，模型重点记录对象、状态、动作、条件、结果、异常及关联入口，按需核实旧规则后局部迁移。

PRD与原型在任务的 requirement_sources 中保存来源版本。模型继续引用已保存任务要求或纠正、已索引项目文档与代码；任务中的图片哈希只证明来源可读和版本，不能证明图中业务含义。服务不会自行推断视觉相似、业务语义或自动确认团队规范。

## 0.12：实体和精确业务关系

在新版模型的 entities 中可为对象增加稳定 `id`、已核对的 `aliases` 和 `source_ids`。别名必须有实体 ID 和明确来源；同名或字面相似不自动视为同一个实体。id 在本模型内稳定，跨模型引用仍明确指定目标模型。

relations 保留原来的方向（当前模型 → 目标模型）和 kind。需要精确关联时增加：

- `entity_ids`：本模型的对象 ID。
- `target_model_id` 与 `target_entity_ids`：目标模型和其中的对象 ID。
- `target_model_id` 与 `target_rule_ids`：实际依赖的目标规则 ID。

所有引用必须存在，不允许伪引用；保存时由服务记录实体、目标规则及其证据版本。只改目标摘要或无关规则，不会让精确关系全部失效；实际依赖的规则、证据、实体或目标文件变更仍要求复核。未使用 target_rule_ids 的旧关系继续按整个目标模型修订号检查，不能伪造精确依赖或删除旧依据。

`project_context.business_graph` 提供双向检索的关系线索，原方向保留在 from_model/to_model。默认 relation_depth:1，显式需要最多设为2；每次最多20个节点、30条边，种子过多或超出层数会返回 truncated。默认摘要保留入口，作出修改判断前按模型/规则 ID 读取当前详情和证据，不能把关系图当成已验证的完整调用图。
