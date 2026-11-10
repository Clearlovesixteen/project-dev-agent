# Project Dev Agent 0.13.4

此目录是 Codex 插件发布产物，由 `npm run build:plugin` 生成，请修改源码后重新构建。

运行环境：Node.js 18.19.0+ 和 Git。依赖已打包，无需 npm install。使用 Node 18.19+ 的业务项目可以直接使用，无需升级项目 Node。

安装、更新和迁移说明：[仓库 README](https://github.com/Clearlovesixteen/project-dev-agent#readme)。

新安装默认 auto，信任 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 五类钩子后可直接提交开发需求；首次开发自动初始化当前 Git 仓库。支持的修改前会核对本轮任务、上下文、实现依据和目标范围；缺失时由 Agent 补齐后重试。仍可明确使用 `project-dev`；调整设置用 `project-dev-setup`。旧 manual 在新版首次运行时自动迁移为 auto，无需手动开启；迁移只执行一次，后续主动切回 manual 的设置保留，工作范围与诊断开关不变；安装不等于钩子已信任或本轮已参与。新安装首次运行默认向维护者发送不含代码、需求或对话正文的运行诊断，可通过项目设置关闭；已有关闭和自定义配置保持原样。
个人设置在 Codex 用户目录的 `project-dev-agent/settings.json`，项目记录在业务仓库的 `.project-dev/local/`，不会随插件升级被替换。
