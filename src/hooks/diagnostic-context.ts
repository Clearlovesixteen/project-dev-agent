import type { DiagnosticContext } from "../observability/diagnostic-context.js";
import type { NativeHookInput } from "./contracts.js";
import { projectTool, toolArguments } from "./tool-policy.js";
import type { CommandDecision } from "./shell-policy.js";
import { shellSyntax } from "./shell-syntax.js";
import { programName } from "./shell-commands.js";

/** 只返回有限能力族；未知程序、参数、分支和文件名绝不进入诊断对象。 */
function family(words: string[]): NonNullable<DiagnosticContext["command_family"]> {
  const program = programName(words[0] ?? "");
  if (program === "git") {
    let index = 1;
    while (["--no-pager", "--no-optional-locks", "--literal-pathspecs"].includes(words[index] ?? "")) index++;
    const action = words[index];
    if (action === "restore") return "git_restore";
    if (action === "add") return "git_add";
    if (["status", "diff", "show", "log", "ls-files", "rev-parse", "check-ignore"].includes(action ?? "")) return "git_read";
    if (["commit", "reset", "checkout", "merge", "rebase", "cherry-pick", "clean", "apply", "switch", "fetch", "pull"].includes(action ?? "")) return "git_write";
    return "unknown";
  }
  if (program === "nl") return "number_lines";
  if (["cat", "head", "tail", "sed", "get-content", "type"].includes(program)) return "text_read";
  if (["rg", "grep", "select-string"].includes(program)) return "search";
  if (["node", "python", "python3", "sh", "bash", "zsh", "powershell", "pwsh", "cmd", "npm", "pnpm", "yarn"].includes(program)) return "script";
  return "other";
}

/** 补充一次纯词法快照；不执行命令、不查Git、不解析或持久化任意原始参数。 */
export function hookDiagnosticContext(input: NativeHookInput, decision?: CommandDecision): DiagnosticContext {
  const context: DiagnosticContext = { version: 1, native_tool: projectTool(input.tool_name) ? "project_mcp"
    : input.tool_name === "apply_patch" ? "patch" : input.tool_name === "Edit" ? "edit" : input.tool_name === "Write" ? "write"
    : decision ? "shell" : "other" };
  if (!decision) return context;
  context.command_class = decision.classification; context.shell_dialect = decision.dialect;
  const args = toolArguments(input), command = args?.command ?? args?.cmd;
  if (typeof command !== "string") return { ...context, command_shape: "unknown", command_family: "unknown" };
  const syntax = shellSyntax(command, decision.dialect);
  if (syntax.state === "unknown") return { ...context, command_shape: syntax.reason === "DYNAMIC" ? "dynamic" : "unknown", command_family: "unknown" };
  const operators = syntax.tokens.filter(token => token.kind === "operator").map(token => token.value);
  context.command_shape = operators.some(value => value.includes(">")) ? "redirection" : operators.some(value => [";", "&&", "||", "&"].includes(value)) ? "chain" : operators.includes("|") ? "pipeline" : "single";
  const segments: string[][] = []; let words: string[] = [];
  for (const token of syntax.tokens) {
    if (token.kind === "word") words.push(token.word.value);
    else { if (words.length) segments.push(words); words = []; }
  }
  if (words.length) segments.push(words);
  const families = [...new Set(segments.map(family))];
  context.command_family = families.length === 1 ? families[0]! : families.every(value => ["number_lines", "text_read"].includes(value)) && families.includes("number_lines") ? "number_lines" : "unknown";
  return context;
}

export function diagnosticAction(reason: string): DiagnosticContext["required_action"] {
  const actions: Record<string, DiagnosticContext["required_action"]> = {
    PROJECT_SETUP_REQUIRED: "prepare", CONTEXT_QUERY_REQUIRED: "query_context", TASK_BINDING_REQUIRED: "open_task",
    TASK_SESSION_MISMATCH: "ask_owner", TASK_TURN_REVIEW_REQUIRED: "check_task", TASK_BASELINE_REVIEW_REQUIRED: "check_task",
    IMPLEMENTATION_BASIS_REQUIRED: "review_basis", IMPLEMENTATION_REFERENCE_STALE: "review_basis", WRITE_SCOPE_REQUIRED: "plan_paths",
    WRITE_TARGET_UNKNOWN: "plan_paths", WRITE_PROJECT_MISMATCH: "review_scope", MERGE_RECOVERY_SCOPE: "review_scope",
    MERGE_RECOVERY_FINISHED: "check_task", MERGE_RECOVERY_COMMAND_REQUIRED: "resolve_conflicts", MERGE_RECOVERY_SOURCE_REQUIRED: "review_source",
    MERGE_RECOVERY_SOURCE_MISMATCH: "review_source", MERGE_RECOVERY_SOURCE_INVALID: "review_source", MERGE_RECOVERY_NOT_STAGED: "stage_conflicts",
    MERGE_MARKERS_REMAIN: "resolve_conflicts", UNMERGED_CHANGES: "resolve_conflicts", MERGE_RECOVERY_CHANGED: "check_task",
  };
  return actions[reason] ?? "review_runtime";
}

/** 错误原因也须固定白名单，不把外部错误code当成新遥测字符串。 */
export function diagnosticCause(error: unknown): NonNullable<DiagnosticContext["cause_code"]> {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["BASELINE_BRANCH_CHANGED", "BASELINE_NOT_REACHABLE", "BASELINE_UNAVAILABLE", "TASK_BINDING_MISMATCH", "PROJECT_NOT_ENROLLED", "PLUGIN_NOT_CONFIGURED", "PROJECT_OUTSIDE_WORKSPACE", "WORKSPACE_CHANGED", "UNMERGED_CHANGES"].includes(code)
    ? code as NonNullable<DiagnosticContext["cause_code"]> : "UNKNOWN";
}
