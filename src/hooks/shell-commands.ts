import { posix, win32 } from "node:path";
import type { ShellDialect } from "./shell-syntax.js";

export type CommandClass = "read_only" | "write" | "unknown" | "management";
/** 规范化跨平台程序名；只处理 exe，不把任意 bat/cmd 脚本伪装成同名系统程序。 */
export function programName(value: string) { return posix.basename(win32.basename(value)).replace(/\.exe$/i, "").toLowerCase(); }

const READ = new Set(["pwd", "ls", "cat", "nl", "head", "tail", "wc", "stat", "file", "readlink", "realpath", "rg", "grep",
  "shasum", "sha256sum", "md5", "md5sum", "cd", "echo", "printf"]);
const POWERSHELL_READ = new Set(["get-content", "get-childitem", "get-item", "get-location", "select-string", "select-object",
  "measure-object", "format-list", "format-table", "get-command", "get-filehash", "resolve-path", "test-path", "set-location", "write-output", "write-host"]);
const WRITE = new Set(["rm", "mv", "cp", "mkdir", "rmdir", "touch", "tee", "truncate", "dd", "patch", "chmod", "chown",
  "set-content", "add-content", "out-file", "remove-item", "move-item", "copy-item", "new-item", "rename-item", "set-item", "clear-content"]);

function gitCommand(args: string[]): CommandClass {
  let index = 0;
  while (index < args.length) {
    const option = args[index]!;
    if (["-C", "--git-dir", "--work-tree"].includes(option)) { if (!args[index + 1]) return "unknown"; index += 2; }
    else if (/^--(?:git-dir|work-tree)=.+/.test(option) || ["--no-pager", "--no-optional-locks", "--literal-pathspecs"].includes(option)) index++;
    else break;
  }
  const action = args[index], rest = args.slice(index + 1), options = rest.slice(0, rest.indexOf("--") < 0 ? rest.length : rest.indexOf("--"));
  if (!action || action.startsWith("-")) return "unknown";
  if (options.some(arg => /^(?:--output|--ext-diff|--textconv|--no-index|--exec)(?:=|$)/.test(arg))) return "unknown";
  if (["fetch", "pull", "switch", "worktree"].includes(action) || action === "checkout" && ["-b", "-B"].includes(rest[0] ?? "")) return "management";
  if (action === "branch") {
    if (!rest.length || rest.includes("--list") && !options.some(arg => /^-(?:[dDmMcC]|-delete|-move|-copy)/.test(arg))) return "read_only";
    return rest.every(arg => ["--show-current", "-a", "-r"].includes(arg)) ? "read_only" : "write";
  }
  if (["status", "diff", "show", "log", "ls-files", "rev-parse", "check-ignore", "--version"].includes(action)) return "read_only";
  return ["add", "commit", "reset", "restore", "checkout", "merge", "rebase", "cherry-pick", "clean", "apply"].includes(action) ? "write" : "unknown";
}

/** 这里只核对少量已知能力与危险选项；未知程序、表达式和执行扩展仍交修改准备检查。 */
export function commandCapability(words: string[], dialect: ShellDialect): CommandClass {
  if (!words[0]) return "unknown";
  const name = programName(words[0]), args = words.slice(1);
  // 参数引用不会改变选项含义，只有 -- 才能结束选项解析。
  const separator = args.indexOf("--"), options = separator < 0 ? args : args.slice(0, separator);
  if (WRITE.has(name)) return "write";
  if (name === "file" && options.some(arg => arg === "--compile" || /^-[^-]*C/.test(arg))) return "write";
  if (["codex", "codex-cli", "codex.cmd"].includes(name)) {
    let index = 0;
    while (["-c", "--config", "-p", "--profile"].includes(args[index] ?? "")) index += 2;
    return args[index] === "plugin" || args[index] === "--version" ? "management" : "unknown";
  }
  if (["node", "npm", "pnpm", "yarn", "git"].includes(name) && ["--version", "-v"].includes(args[0] ?? "")) return "read_only";
  if (name === "git") return gitCommand(args);
  if (name === "rg" && options.some(arg => /^(?:--pre|--pre-glob|--hostname-bin)(?:=|$)/.test(arg))) return "unknown";
  if (READ.has(name)) return "read_only";
  if (dialect === "powershell" && POWERSHELL_READ.has(name)) return "read_only";
  if (dialect === "cmd" && ["type", "dir", "cd", "chdir"].includes(name)) return "read_only";
  if (name === "sed") {
    if (options.some(arg => /^-.*i|^--in-place(?:=|$)/.test(arg))) return "write";
    const rest = args[0] === "-n" ? args.slice(1) : args;
    // 数字范围的 p 只输出文本；无文件参数时读取 stdin，覆盖 nl | sed 的常见阅读方式。
    // 不放开其他脚本、执行/写文件指令或后续选项。
    return /^\d+(?:,\d+)?p$/.test(rest[0] ?? "") && rest.slice(1).every(arg => !arg.startsWith("-")) ? "read_only" : "unknown";
  }
  return "unknown";
}
