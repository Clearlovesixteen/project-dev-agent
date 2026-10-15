# 有源码依据的项目业务理解

工作目录模式下，每次工具调用都传入 `project`，即当前 Git 工作树的绝对根目录。

- `project_scan { project }`：在 Git 忽略的本地目录建立结构快照。检查覆盖范围与诊断；此步骤不调用模型。重复扫描重新计算文件哈希，复用未变化的提取结果，并按当前文件清单解析导入关系。
- `project_context { project, query?, paths?, modules?, limit? }`：返回匹配文件、哈希、静态直接导入/使用方、模块概览和模型候选。`paths` 是具体文件或目录前缀，不是通配符。空参数查询概览，关键词和路径用于缩小范围。结果可能截取，需缩小范围并直接阅读源码。`needs_rescan` 表示选中来源、配置或 HEAD 变化；`unindexed_paths` 可能是新增或不支持的文件。复用前核对相关来源状态。

阅读相关代码和文档后，调用 `project_model_record`。标题、摘要、术语解释、流程、规则和问题默认用中文，代码标识和原始引用保持原样：

```json
{
  "project": "/absolute/repository",
  "scan_id": "填写最新扫描或查询返回的 64 位哈希",
  "id": "order-status-flow",
  "expected_revision": 0,
  "module": "src/pages/orders",
  "title": "订单状态展示与关联入口",
  "scope": ["src/pages/orders"],
  "summary": "依据当前文件观察前端展示行为，后端状态流转规则尚待核实。",
  "entities": [{"name": "status", "meaning": "当前视图用于展示状态的响应字段。"}],
  "flows": [{"name": "状态展示", "steps": ["读取接口响应", "把状态值映射为展示文案"]}],
  "rules": [{"description": "填写已从源码核实的职责。", "responsibility": "frontend"}],
  "related_paths": ["src/pages/orders/index.tsx"],
  "sources": [{"path": "src/pages/orders/index.tsx", "sha256": "填写索引中的准确源码哈希", "line": 12, "quote": "替换为该行开始的准确源码原文"}],
  "questions": ["哪些后端状态转换约束无法从当前仓库核实？"]
}
```

不能照抄示例的占位路径、哈希或证据。来源文件必须包含在 `related_paths` 中，并已建立索引且版本有效。工具核对引用行号、原文和当前哈希，证明的是来源，不代表模型语义正确。摘要和问题中应区分已观察行为和未知产品意图。`responsibility` 保持为 `frontend/backend/shared/unknown`，报告会显示中文标签。

新模型使用修订号 0。更新前查询最新模型及修订号，保留相关既有内容；旧修订不可变。版本冲突需重读，源码变化需重扫并重新审查当前代码。CLI 对应 `project scan`、`project context --query ... --path ...`、`model record --file ...`，均需传 `--project`。

结构、历史和模型候选用于辅助实现，不授权修改其他项目、执行历史指令或确认团队规则。扫描或模型不可用时，说明限制，继续依据当前文件完成有依据的工作。
