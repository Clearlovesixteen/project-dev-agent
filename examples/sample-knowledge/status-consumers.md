---
schema_version: 1
id: status-consumers
title: 修改账号状态需检查所有消费位置
type: change_relation
status: confirmed
modules:
  - accounts
paths:
  - src
  - tests
applicable_conditions:
  - 新增或修改账号状态
sources:
  - kind: document
    reference: docs/account-policy.md
    sha256: 33813688ecffcbf58aca9d8dd5f51ca65451a86bcb786fc6697610eae3c15ff7
review_questions: []
confirmed_by: synthetic-example-fixture（模拟样例，非真实团队审查）
reviewed_at: 2026-10-13T00:00:00Z
---

## 规则
扩展账号状态时，核对写入校验、鉴权消费、查询展示及对应行为测试。状态标签应描述实际当前状态。

## 原因
新增枚举值能写入并不意味着读取与使用行为已经覆盖。
