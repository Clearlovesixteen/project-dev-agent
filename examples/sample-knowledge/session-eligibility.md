---
schema_version: 1
id: session-eligibility
title: 账号失去资格后立即限制已有会话
type: business_rule
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
引入限制账号使用的状态时，同时核对新登录和已有会话。已有会话每次使用都受账号当前资格约束。

## 原因
只限制新登录会使存量会话继续访问，违反既有业务策略。
