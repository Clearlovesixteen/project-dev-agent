# Project Dev Agent 0.6.3

此目录是 Codex 插件发布产物，由 `npm run build:plugin` 生成，请修改源码后重新构建。

运行环境：Node.js 18.19.0+ 和 Git。依赖已打包，无需 npm install。使用 Node 18.19+ 的业务项目可以直接使用，无需升级项目 Node。

安装、更新和迁移说明：[仓库 README](https://github.com/Clearlovesixteen/project-dev-agent#readme)。

直接使用 `project-dev` 开发，首次运行自动初始化当前 Git 仓库；需要调整工作目录时再使用 `project-dev-setup`。
个人设置在 Codex 用户目录的 `project-dev-agent/settings.json`，项目记录在业务仓库的 `.project-dev/local/`，不会随插件升级被替换。
