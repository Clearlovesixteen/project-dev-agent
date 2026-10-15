---
schema_version: 1
id: service-boundary
title: 账号校验集中在服务层
type: code_convention
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
    reference: AGENTS.md
    sha256: e03baaa904ffd7e5c0117e90b6064c2c78f85d9a3c226f9ebfdf8e6c2c0955a7
review_questions: []
confirmed_by: synthetic-example-fixture（模拟样例，非真实团队审查）
reviewed_at: 2026-10-13T00:00:00Z
---

## 规则
新增账号状态或写入规则时，在 account service 中统一校验。鉴权与展示层通过 service 读取账号，不直接写 store。

## 原因
保持已有分层，防止入口绕过状态校验。
