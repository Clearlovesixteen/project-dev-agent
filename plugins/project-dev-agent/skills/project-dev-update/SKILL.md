---
name: project-dev-update
description: 从已配置的 Codex 插件源检查或更新 Project Dev Agent，保留个人配置和项目记录。用于用户要求检查插件版本或更新插件时，例如“更新 Project Dev Agent 插件”；仅更新插件本身。
---

# 插件更新

使用 Codex 原生插件管理器，无需克隆源码、运行 npm 安装或创建独立更新器。默认用中文说明状态、错误原因和更新结果，保留命令、版本号及错误码原样。

1. 工具可用时读取 `plugin_status`，确认当前运行版本与工作目录。
2. 找到用户已安装的 Codex CLI（PATH 中的 `codex` 或应用内现有可执行文件）。执行 `codex plugin marketplace list --json`，再用 `codex plugin list --marketplace project-dev-team --json` 只查询本插件源，避免无关插件目录查询拖慢更新。插件 ID 为 `project-dev-agent@project-dev-team`。核对已配置源和安装版本，不展示无关设置或凭据。旧 CLI 不支持筛选参数时，按其帮助使用 `codex plugin list --json`。
3. 用户仅查询安装版本时，报告后结束。检查新版本需要刷新插件源，可能同时更新已启用插件；用户尚未要求更新时，先说明这个影响。
4. 用户已要求更新时，执行 `codex plugin marketplace upgrade project-dev-team --json`。同时检查退出状态和返回的 `errors`，退出码为 0 不足以证明成功。身份验证、下载或刷新失败时说明具体失败，不宣称完成。
5. 再用 `codex plugin list --marketplace project-dev-team --json` 核对并报告安装版本。已验证的 Codex 会在刷新源时更新启用插件的缓存；较旧兼容 CLI 若需确保安装，在刷新成功后执行 `codex plugin add project-dev-agent@project-dev-team --json`。未核对实际安装版本时不得声称已更新。
6. 提示新建对话或重启 Codex，以加载新版 MCP 进程和 Skill。当前对话的 `plugin_status` 可能仍报告旧进程版本，需区分运行版本与已安装版本。

保留个人工作目录设置、项目记录、当前任务和其他插件。不擅自更换插件源或 Git ref，不运行 npm 生命周期脚本，不手改插件缓存。缺少源或 CLI 不支持命令时，说明具体配置或版本问题。公开 HTTPS 源无需 GitHub 身份验证；仅在已配置源需要时使用既有凭据，不在聊天中索取 Token。更新插件不授权提交、推送或修改业务代码。
