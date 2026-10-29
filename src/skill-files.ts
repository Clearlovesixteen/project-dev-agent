/** 所有安装方式共用同一份 Skill 运行资产清单，避免入口升级后缺少引用的工作流。 */
export const SKILL_FILES = ["SKILL.md", "references/task-inputs.md", "references/history-inputs.md",
  "references/understanding-inputs.md", "references/generation-rules.md", "references/workflow.md", "references/spec-and-interaction.md"] as const;
