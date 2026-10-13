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
    sha256: e11c4342daf10a870a14401d1fc893f23c2b871aef559c5ec37fab1a818c7d37
review_questions: []
confirmed_by: synthetic-example-fixture (not a real team review)
reviewed_at: 2026-10-13T00:00:00Z
---

## 规则
扩展账号状态时，核对写入校验、鉴权消费、查询展示及对应行为测试。状态标签应描述实际当前状态。

## 原因
新增枚举值能写入并不意味着读取与使用行为已经覆盖。
