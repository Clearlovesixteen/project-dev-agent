---
name: project-dev-update
description: Update the installed Project Dev Agent plugin to the newest version from its configured private Codex marketplace. Use when the user asks to update or check this plugin, including 更新 Project Dev Agent 插件. Does not update business projects.
---

# Update Project Dev Agent

Use Codex's native plugin manager; no source checkout, npm installation or separate updater is needed.

1. Read `plugin_status` for the currently running version and workspace, if available.
2. Locate the user's installed Codex CLI (`codex` on PATH, or its existing app-bundled executable). Run `codex plugin marketplace list --json` and `codex plugin list --json`. The plugin ID is `project-dev-agent@project-dev-team`. Inspect the configured marketplace source and installed version. Do not display unrelated settings or credentials.
3. If the user only asked to check the installed version, report it and stop. Checking for a new release requires refreshing the marketplace and can update an enabled plugin; explain this if no update was requested.
4. For an explicit update request, run `codex plugin marketplace upgrade project-dev-team --json`. Inspect both the command exit status and the returned `errors`; a zero exit status alone is insufficient. Do not continue to success on authentication or refresh errors.
5. Run `codex plugin list --json` again and report the installed version. The tested Codex version refreshes the enabled plugin cache as part of marketplace upgrade. If an older compatible CLI requires ensuring installation, use `codex plugin add project-dev-agent@project-dev-team --json` after a successful refresh. Never claim a newer installed version without checking it.
6. Start a new chat or restart Codex to load the new MCP process and skills. The current chat's `plugin_status` may still report the old running version; distinguish it from the new installed version.

Preserve personal workspace settings, project records, current tasks and unrelated plugins. Never silently add a different marketplace, change its Git ref, run npm lifecycle scripts, or edit the plugin cache manually. A missing marketplace or unsupported CLI command needs a setup/version explanation. Use the existing GitHub identity; never ask for a token in chat. Updates do not authorize commits, pushes or modifications to business code.
