import { relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { AppError } from "../domain/error.js";
import { RelativePathSchema } from "../domain/common.js";
import type { ValidationPlanInput, ValidationRun } from "./validation-contracts.js";

type Check = ValidationPlanInput["checks"][number];
/** 首版只接入有明确事件协议的 Node 测试；其他检查继续原流程，不能把退出码冒充场景结果。 */
export function behaviorArguments(check: Check): string[] {
  if (!check.behavior_report) return check.args;
  const targets = check.args.filter(arg => arg !== "--test");
  if (check.command !== "node" || check.args.filter(arg => arg === "--test").length !== 1 || !targets.length
    || targets.some(arg => !RelativePathSchema.safeParse(arg).success || !/\.(?:[cm]?js)$/.test(arg) || /[\*?\[\]]/.test(arg) || arg.startsWith("-")))
    throw new AppError("BUSINESS_TEST_ADAPTER_COMMAND", "Node 场景检查使用 node --test 加明确的 JS 测试文件；不能使用 -e、shell、通配符或自定义报告器");
  const reporter = fileURLToPath(new URL(import.meta.url.endsWith(".mjs") ? "./behavior-reporter.mjs" : "./behavior-reporter.js", import.meta.url));
  return ["--test", `--test-reporter=${reporter}`, ...targets];
}

/** 从已验证的参数取得项目相对路径，给计划的来源指纹与场景绑定使用。 */
export function behaviorFiles(check: Check): string[] {
  return check.behavior_report ? behaviorArguments(check).slice(2).map(path => posix.join(check.cwd, path)) : [];
}

/** 独立于截断控制台日志解析结构化事件；缺少结束事件、超限或错误内容都保持未核验。 */
export class BehaviorCapture {
  private buffer = "";
  private bytes = 0;
  private invalid = false;
  private complete = false;
  private readonly decoder = new StringDecoder("utf8");
  private readonly cases: NonNullable<ValidationRun["behavior"]>["cases"] = [];
  constructor(private readonly root: string) {}
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > 512_000) { this.invalid = true; return; }
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (this.complete) { this.invalid = true; continue; }
        if (event.kind === "complete" && event.count === this.cases.length) { this.complete = true; continue; }
        if (event.kind !== "case" || typeof event.name !== "string" || event.name.length > 300 || typeof event.file !== "string"
          || !["passed", "failed", "skipped", "todo"].includes(event.state) || this.cases.length >= 1000) { this.invalid = true; continue; }
        const file = event.file.startsWith("file:") ? fileURLToPath(event.file) : event.file;
        const path = relative(this.root, resolve(file)).split("\\").join("/");
        if (!RelativePathSchema.safeParse(path).success || posix.isAbsolute(path)) { this.invalid = true; continue; }
        this.cases.push({ name: event.name, file: path, state: event.state });
      } catch { this.invalid = true; }
    }
    if (this.buffer.length > 10_000) { this.invalid = true; this.buffer = ""; }
  }
  finish(): NonNullable<ValidationRun["behavior"]> {
    return { adapter: "node-test", complete: this.complete && !this.invalid && !(this.buffer + this.decoder.end()).trim(), cases: this.cases };
  }
}
