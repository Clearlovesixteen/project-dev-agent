# 输入归一和会话关联

这是 Agent 内部约定，用户只需提供需求或已有文档，不需要填写表单。

- PRD、SDD、PRD+SDD 分别保存 `spec_input.kind` 为 `prd`、`sdd`、`combined`；普通自然语言用 `request` 或兼容旧调用不传该字段。
- `spec_input.source_ids` 指向 `requirement_sources` 中真实保存的来源 ID；原始任务正文由服务保留为 `task-request`。贴入聊天的文档可引用 task-request；文件来源要保留路径、实际哈希及原文，具体字段以原工具声明为准。
- 明确需求、既有实现、尚未确认的假设分开。PRD 没写的接口路径、状态枚举和责任边界不能臆造；SDD 中“由 PRD 推导，人工复核”的内容仍属于待核对设计。
- PRD 的状态限制对应业务规则；SDD 的接口、组件和改动入口对应当前源码证据；二者共同对应具体验收及相关变化位置。沿用已有 SDD，不生成同内容的新文档或第二套任务。

可信钩子会给 `session_id`、可能的 `turn_id`/`actor_id`、`context_id`。本轮插件调用统一携带 `interaction`；不要从项目文件或历史对话冒用其他会话身份。首次 `task_open` 在 interaction 中生成 UUID `operation_id`，参数相同的重试复用该值，需求变更另开新操作。后续 `task_update`/`task_check` 带同一个 session/actor；任务修订号仍按实际结果递增。

新的会话绑定任务不会被其他会话默认恢复或修改。同一工作树仍只允许一个活跃写任务；遇到归属冲突说明实际情况，不能删任务、改 owner、重试换身份或自动中止别人的任务。旧版无 owner 的任务保持原有显式调用方式；只读指定 task_id 可查看历史，不能因此认领写权限。

`context_id` 是回执关联，不是“模型已经理解/采用”的证明。后续使用 project_context 获取新摘要时，改用工具返回的新 context_id。使用已发回执仍需遵守当前用户要求、工具校验及专业技能。开发者诊断只记录元数据，不传 PRD、SDD、源码、对话或路径。
