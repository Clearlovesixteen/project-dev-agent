# Personal delivery implementation plan

**Goal:** 在 gc-web 的多个仓库中，通过 Codex 使用同一份 Project Dev Agent；先完成个人可用交付，再供团队安装。

**Architecture:** 保留现有任务、知识和证据合同。新增显式按仓库路由的 workspace 模式，所有请求限制在配置的目录内。全局 Skill 和 MCP 只安装一次；个人接入仅按需写 Git 本地忽略规则和被忽略的任务数据，团队共享知识仍走原有审查流程。

**Tech Stack:** 现有 TypeScript、MCP SDK、Zod、Node、Git；通过 Codex 官方 CLI 管理 MCP 配置，不自行拼改用户配置。

1. `src/workspace.ts` 与 `src/server.ts`：新增 `serve --workspace`，六个工具均明确项目范围；拒绝越界路径、符号链接逃逸和跨仓库任务 ID。
2. `src/personal-setup.ts`：`project_prepare` 默认为只读，显式 apply 才向 Git 本地 `info/exclude` 追加任务忽略规则；保持已有内容和业务工作树，使用 Git 惯例的 exclude.lock。
3. `src/storage/task-store.ts`、`src/task-service.ts`：`task_check` 无 ID 时恢复唯一活动任务；没有活动任务明确报告，基线失效仍返回可恢复记录。
4. `src/codex-install.ts`、`src/cli.ts`：安装预览、一次连接、可逆断开；预检自定义 Skill/MCP 冲突，保留其它服务器配置。
5. `skills/project-dev/`、README 和接入文档：适配 workspace、恢复和空知识库场景，提供中文日常使用入口。
6. 测试真正的 STDIO 多仓库调用、隔离、预览不写、重复准备、已有改动保留、任务恢复和安装冲突。跑完整类型检查和测试，再从打包产物安装。
7. 安装到稳定本地工具目录，为 gc-web 注册真实 Codex 连接、验证 Skill 和 MCP，给出个人使用说明及团队分发包。实际业务正确率仍需真实需求试用后评估。

本次不修改业务功能、不批量初始化全部业务仓库、不伪造业务规则的人工确认。脏工作树仍要求由开发者决定提交、保留或使用干净 worktree；工具不得自动 stash、reset 或 commit。
