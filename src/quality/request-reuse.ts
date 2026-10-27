import { baselineContent } from "../git/workspace-baseline.js";
import type { WorktreeBinding } from "../git/index.js";
import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import { RelativePathSchema } from "../domain/common.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { loadConfig } from "../knowledge/config.js";
import { digest } from "../knowledge/document.js";
import { readGit, decodeGitOutput } from "../git/command.js";
import { mapFiles, readMap } from "../understanding/store.js";
import { excluded, safeSource, MAX_SOURCE } from "../understanding/scan.js";
import {
  implementationContext,
  programFile,
} from "./implementation-context.js";
import { httpUsage } from "./http-usage.js";
import { ImplementationBaselineSchema } from "./contracts.js";

/** 任务基线只记录已有统一入口；工作树须已由调用方确认干净。 */
export async function captureImplementationBaseline(binding: WorktreeBinding) {
  const files = new ProjectFiles(binding.root);
  try {
    const map = await readMap(files);
    if (!map)
      return ImplementationBaselineSchema.parse({
        state: "not_scanned",
        request_entries: [],
        truncated: false,
      });
    const { config } = await loadConfig(files);
    const entries = (await mapFiles(files)).filter(
      (entry) => !excluded(entry.path, config),
    );
    const context = await implementationContext(files, entries, config);
    return ImplementationBaselineSchema.parse({
      state: "ready",
      scan_id: map.scan_id,
      truncated:
        context.request_truncated ||
        !map.coverage.complete ||
        context.request_entries.some(
          (entry) => entry.source_state !== "current",
        ),
      request_entries: context.request_entries
        .filter(
          (entry) =>
            entry.role === "shared_request_entry" &&
            entry.source_state === "current",
        )
        .map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    });
  } catch {
    return ImplementationBaselineSchema.parse({
      state: "unavailable",
      request_entries: [],
      truncated: true,
    });
  }
}

/** Git 基线读取不执行项目代码；仅允许已列出的真实项目路径，并继续遵循排除和容量限制。 */
async function baselineText(
  binding: WorktreeBinding,
  head: string,
  path: string,
  tracked: Set<string>,
): Promise<string> {
  RelativePathSchema.parse(path);
  if (!tracked.has(path)) return "";
  const result = await readGit(binding.root, ["show", `${head}:${path}`]);
  if (result.stdout.length > MAX_SOURCE)
    throw new AppError("FILE_LIMIT", "基线文件超出复用检查容量");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}

/** 比较新增底层请求用法与任务开始前的统一入口，不能把本次新增封装作为“已有能力”。 */
export async function requestReuseReview(
  binding: WorktreeBinding,
  task: Task,
  changed: string[],
) {
  const files = new ProjectFiles(binding.root),
    { config } = await loadConfig(files);
  const candidates = changed.filter(
    (path) =>
      programFile(path) &&
      !excluded(path, config) &&
      !/(?:^|\/)(?:tests?|__tests__|e2e)\/|\.(?:test|spec)\./.test(path),
  );
  if (!candidates.length)
    return {
      state: "checked",
      violations: [],
      exceptions: [],
      established_entries: [],
      truncated: false,
      limitation: "本次没有需要检查的生产代码路径。",
    };
  const tracked = new Set(
    decodeGitOutput(
      (
        await readGit(binding.root, [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          task.baseline_head,
        ])
      ).stdout,
    )
      .split("\0")
      .filter(Boolean),
  );
  for (const entry of task.workspace_baseline?.entries ?? []) {
    if (entry.kind === "file") tracked.add(entry.path);
    else tracked.delete(entry.path);
  }
  const baselineCache = new Map<string, Promise<string>>();
  const before = (path: string) => {
    let pending = baselineCache.get(path);
    if (!pending) {
      pending = baselineContent(
        binding,
        task.baseline_head,
        path,
        task.workspace_baseline,
      );
      baselineCache.set(path, pending);
    }
    return pending;
  };
  const map = await readMap(files);
  let entries = task.implementation_baseline?.request_entries ?? [];
  let discoveryIncomplete = task.implementation_baseline?.truncated ?? false;
  // 兼容旧任务或创建时未扫描的任务：从当前索引补查，但只接受基线已经存在且确有底层能力的入口。
  if (
    !task.implementation_baseline ||
    task.implementation_baseline.state !== "ready" ||
    discoveryIncomplete
  ) {
    if (map) {
      const context = await implementationContext(
        files,
        (
          await mapFiles(files)
        ).filter((entry) => !excluded(entry.path, config)),
        config,
        candidates,
      );
      entries = [
        ...new Map(
          [
            ...entries,
            ...context.request_entries
              .filter(
                (entry) =>
                  entry.role === "shared_request_entry" &&
                  tracked.has(entry.path),
              )
              .map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
          ].map((entry) => [entry.path, entry]),
        ).values(),
      ];
      discoveryIncomplete = context.request_truncated;
    }
  }
  const established = [];
  for (const entry of entries) {
    if (excluded(entry.path, config) || !tracked.has(entry.path)) continue;
    const original = await before(entry.path);
    if (httpUsage(original).size)
      established.push({ path: entry.path, sha256: digest(original) });
  }
  const violations = [],
    exceptions = [];
  let unreadable = 0,
    newHttp = 0;
  for (const path of candidates.slice(0, 500)) {
    let current: string;
    try {
      current = await safeSource(files, path, config);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) unreadable++;
      continue;
    }
    const now = httpUsage(current);
    if (!now.size) continue;
    const previous = httpUsage(await before(path));
    const added = [...now]
      .filter(([key, count]) => count > (previous.get(key) ?? 0))
      .map(([key]) => key);
    if (!added.length || established.some((entry) => entry.path === path))
      continue;
    newHttp++;
    const owner = (value: string) =>
      /^(?:apps|packages)\/[^/]+/.exec(value)?.[0];
    const applicable = established.filter(
      (entry) => !owner(entry.path) || owner(entry.path) === owner(path),
    );
    if (!applicable.length) continue;
    const exception = task.change_items.find(
      (item) =>
        item.target_path === path &&
        item.status === "checked" &&
        item.reuse_exception,
    )?.reuse_exception;
    let validException = false;
    if (
      exception &&
      applicable.some((entry) => entry.path === exception.inspected_path) &&
      !excluded(exception.inspected_path, config)
    ) {
      try {
        const inspected =
          exception.source_version === "baseline"
            ? await before(exception.inspected_path)
            : await safeSource(files, exception.inspected_path, config);
        const snippet = inspected
          .split("\n")
          .slice(
            exception.line - 1,
            exception.line - 1 + exception.quote.split("\n").length,
          )
          .join("\n");
        validException =
          digest(inspected) === exception.sha256 &&
          snippet.includes(exception.quote);
      } catch {
        /* 失效或伪造的阅读依据不能解除复用检查。 */
      }
    }
    if (validException)
      exceptions.push({
        path,
        reason: exception!.reason,
        inspected_path: exception!.inspected_path,
      });
    else
      violations.push({
        path,
        added_low_level_usage: added,
        existing_entries: applicable.map((entry) => entry.path),
        reason:
          "项目已有统一请求入口，本次新增底层请求用法可能绕过鉴权、拦截器或错误处理。先复用；确实存在缺口时在对应清单项记录有代码依据的 reuse_exception。",
      });
  }
  const incomplete =
    candidates.length > 500 ||
    unreadable > 0 ||
    (newHttp > 0 && ((!established.length && discoveryIncomplete) || !map));
  return {
    state: violations.length
      ? "violations"
      : incomplete
      ? "incomplete"
      : "checked",
    violations: violations.slice(0, 20),
    exceptions: exceptions.slice(0, 10),
    established_entries: established,
    truncated: incomplete || violations.length > 20 || exceptions.length > 10,
    limitation:
      "只检查有界范围内 JS/TS/Vue/Svelte 的明确底层 HTTP 新用法，不是完整 AST 或所有基础设施检查；类型导入、未变化旧用法与统一入口内部维护不算重复封装。依据匹配不能自动证明例外理由合理。",
  };
}

export async function assertRequestReuse(
  binding: WorktreeBinding,
  task: Task,
  changed: string[],
) {
  const result = await requestReuseReview(binding, task, changed);
  if (result.violations.length)
    throw new AppError(
      "PROJECT_REUSE_REQUIRED",
      `请复用项目既有请求入口，或核实必要例外：${result.violations
        .map((item) => item.path)
        .join("、")}`,
    );
  if (result.state === "incomplete")
    throw new AppError(
      "PROJECT_REUSE_CONTEXT_REQUIRED",
      "请求复用检查覆盖不完整，请刷新索引、核对无法读取的来源并缩小检查范围后再关闭任务",
    );
}
