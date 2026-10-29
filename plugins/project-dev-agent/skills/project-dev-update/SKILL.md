---
name: project-dev-update
description: 从已配置的 Codex 插件源检查或更新 Project Dev Agent，保留个人配置和项目记录。用于用户要求检查插件版本或更新插件时，例如“更新 Project Dev Agent 插件”；仅更新插件本身。
---

# 插件更新

使用 Codex 原生插件管理器。默认用中文说明状态、错误原因和更新结果，保留命令、版本号及错误码原样。用户只需明确要求更新，不需要另行安装管理器或克隆源码。

## 核对范围

找到已安装且支持 `plugin` 的 Codex CLI（PATH 中的 `codex` 或应用内现有可执行文件）。执行：

```bash
codex plugin marketplace list --json
codex plugin list --marketplace project-dev-team --json
```

插件 ID 为 `project-dev-agent@project-dev-team`。只查询本插件源；旧 CLI 不支持筛选时按其帮助处理。工具可用时另读 `plugin_status`，区分当前会话运行版本与实际安装版本。用户仅查询安装版本时，报告后结束；刷新源可能更新已启用插件，需要用户已要求检查或更新。

## 轻量刷新

本插件官方源为 `Clearlovesixteen/project-dev-agent`，支持已配置的 GitHub 简写、HTTPS 或 SSH 地址。核对目标源和实际配置的 ref、稀疏目录；仅读取相关配置段，不输出其他设置或凭据。

官方 Git 源使用下面的**单次配置覆盖**刷新，避免下载整个源码仓库的历史文件。保留原来的地址、协议和 ref；已有额外稀疏目录时合并保留。自定义仓库或本地源沿用其配置，不能套用这里的目录布局。

```bash
codex -c 'marketplaces.project-dev-team.sparse_paths=[".agents/plugins","plugins/project-dev-agent"]' plugin marketplace upgrade project-dev-team --json
```

`-c` 只影响本次命令，不修改持久配置。不能用 `marketplace add` 替换已登记源：Codex 会把新增稀疏参数视为不同源而拒绝；也不要先移除旧源。不要未经验证退回完整克隆。CLI 不支持所需参数时，明确报告需更新 Codex。

同时检查退出码和 JSON `errors`。退出码非零、返回错误或下载未完成，都不能宣称更新成功：

- 下载超时、连接中断或 `early EOF`：用相同轻量命令最多再试一次，合计不超过两次；再次失败就说明具体阶段并保留旧版。
- 身份验证、主机密钥校验、权限或配置错误：立即停止，报告原因，不反复重试、不跳过 SSH 校验、不修改全局 Git/SSH 设置，也不自动切换协议。
- 不支持的 CLI 命令、沙箱拒绝或非预期错误：报告具体阻塞，不能把本地权限问题归因于网络。

## 核验结果

刷新成功后，用相同 `-c` 覆盖执行 `plugin list --marketplace project-dev-team --json`，核对安装版本。读取本次 `upgradedRoots` 内对应发布目录的清单：旧版为 `plugins/project-dev-agent/plugin.json`，0.12 起为 `plugins/project-dev-agent/.codex-plugin/plugin.json`，本地源则在其现有根目录查找。只在第一个文件确实不存在时检查兼容入口，读取失败或内容损坏不能当作版本不存在。比较源版本与安装版本；版本不一致或没有可核对的源版本、安装记录时，不能报告“已是最新版”。不要为满足旧路径另写根清单，否则宿主会选错入口而漏掉钩子。

若源已成功刷新，但原生客户端未同步已安装缓存，使用相同覆盖执行 `plugin add project-dev-agent@project-dev-team --json` 确保安装，再核验版本；刷新失败时不得继续此步并把旧缓存当作新版。

报告更新前后版本或明确的失败阶段。安装版本未变但刷新、安装核验均成功时，说明“当前配置的 ref 无新版本”；固定标签不自动切换到 main。成功后提示新建对话或重启 Codex 加载新 MCP 和 Skill，当前对话不会热切换。

保留个人工作目录设置、项目记录、当前任务和其他插件。不擅自更换插件源或 Git ref，不运行 npm 生命周期脚本，不手改插件缓存。公开 HTTPS 源无需 GitHub 身份验证；仅在已配置源需要时使用既有凭据，不在聊天中索取 Token。更新插件不授权提交、推送或修改业务代码。
