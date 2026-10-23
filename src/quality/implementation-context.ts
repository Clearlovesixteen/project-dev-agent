import type { MapFile } from "../understanding/contracts.js";
import type { ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { safeSource } from "../understanding/scan.js";
import { HTTP_LIBRARIES, httpUsage, codeMask } from "./http-usage.js";
import { posix } from "node:path";

export const programFile = (path: string) => /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(path);
/** 项目级基础设施不能被新业务目录的路径过滤掉。候选与真实用法一起返回，实际语义由执行者阅读核对。 */
export async function implementationContext(files: ProjectFiles, entries: MapFile[], config: ProjectConfig, paths: string[] = []) {
  const callers = new Map<string, string[]>();
  for (const entry of entries) for (const item of entry.imports) if (item.target) {
    const list = callers.get(item.target) ?? []; if (!list.includes(entry.path)) list.push(entry.path); callers.set(item.target, list);
  }
  const owner = (path: string) => /^(?:apps|packages)\/[^/]+/.exec(path)?.[0];
  const owners = new Set(paths.map(owner));
  const inScope = (path: string) => !paths.length || owners.has(undefined) || !owner(path) || owners.has(owner(path));
  // 用结构和真实调用关系发现公共实现，避免把“项目习惯”收窄成某类基础库。
  const sourceFile = (path: string) => /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|java|kt|cs|rs)$/.test(path);
  const reusable = entries.filter(entry => sourceFile(entry.path) && inScope(entry.path) && entry.role !== "test"
    && (entry.role === "shared" || (callers.get(entry.path)?.length ?? 0) > 0))
    .sort((a, b) => (callers.get(b.path)?.length ?? 0) - (callers.get(a.path)?.length ?? 0) || a.path.localeCompare(b.path));
  const shared_entries = [];
  let sharedUnreadable = 0;
  for (const entry of reusable.slice(0, 8)) {
    try {
      const text = await safeSource(files, entry.path, config), consumers = (callers.get(entry.path) ?? []).filter(inScope);
      shared_entries.push({ path: entry.path, sha256: digest(text), source_state: digest(text) === entry.sha256 ? "current" : "changed",
        role: entry.role, symbols: (entry.symbols ?? []).slice(0, 8), consumers: consumers.slice(0, 3), consumer_count: consumers.length,
        reason: "根据共享目录或已有引用发现的候选，需实际阅读职责、使用条件和扩展方式。" });
    } catch { sharedUnreadable++; }
  }
  const possible = entries.filter(entry => programFile(entry.path) && inScope(entry.path) && entry.role !== "test" && (
    entry.imports.some(item => HTTP_LIBRARIES.has(item.specifier)) || /(?:^|\/)(?:http|request|transport|fetcher|httpClient)(?:[.\/-]|$)/i.test(entry.path)
    || (entry.symbols ?? []).some(symbol => /request|http|transport|fetcher/i.test(symbol))))
    .sort((a, b) => (callers.get(b.path)?.length ?? 0) - (callers.get(a.path)?.length ?? 0) || a.path.localeCompare(b.path));
  const request_entries = [];
  let unreadable = 0;
  for (const entry of possible.slice(0, 20)) {
    try {
      const text = await safeSource(files, entry.path, config);
      const usage = httpUsage(text);
      if (!usage.size) continue;
      const source_state = digest(text) === entry.sha256 ? "current" : "changed";
      const consumers = callers.get(entry.path) ?? [];
      const infrastructureHint = /request|http|transport|fetcher/i.test(entry.path) || entry.role === "shared"
        || (entry.symbols ?? []).some(symbol => /request|http|transport|fetcher/i.test(symbol));
      const createsClient = [...usage.keys()].some(key => /:(?:create|extend|new)$/.test(key));
      const publicEntry = consumers.length > 0 && (infrastructureHint || createsClient)
        || infrastructureHint && /\bexport\b|module\.exports/.test(codeMask(text));
      request_entries.push({ path: entry.path, sha256: entry.sha256, source_state, consumers: consumers.slice(0, 3), consumer_count: consumers.length,
        role: publicEntry ? "shared_request_entry" : "http_usage_candidate",
        reason: consumers.length ? "已有模块通过此入口发起请求，先阅读封装及调用约定。" : "存在底层 HTTP 实现，需核对它是否为项目统一入口。" });
    } catch { unreadable++; }
  }
  const ranked = request_entries.sort((a, b) => Number(b.role === "shared_request_entry") - Number(a.role === "shared_request_entry") || b.consumer_count - a.consumer_count || a.path.localeCompare(b.path));
  const distance = (path: string) => Math.max(0, ...paths.map(target => {
    const left = path.split("/"), right = target.split("/"); let count = 0;
    while (count < Math.min(left.length, right.length) && left[count] === right[count]) count++;
    return count;
  }));
  const moduleExamples = entries.filter(entry => sourceFile(entry.path) && inScope(entry.path) && entry.role !== "test" && entry.role !== "shared")
    .sort((a, b) => distance(b.path) - distance(a.path) || Number(/(?:modules|features|pages|views)\//.test(b.path)) - Number(/(?:modules|features|pages|views)\//.test(a.path)) || a.path.localeCompare(b.path));
  const examples = moduleExamples.slice(0, 3).map(entry => ({ path: entry.path, sha256: entry.sha256,
    reason: "按目录与所属范围选出的实现样例；实际阅读其职责拆分、导出、依赖、注释及约定后再决定是否适用。" }));
  const instructionCandidates = entries.filter(entry => inScope(entry.path) && /(?:^|\/)(?:AGENTS|CLAUDE|README|ARCHITECTURE|CONTRIBUTING|conventions|coding[-_]style)\.(?:md|html)$/i.test(entry.path))
    .filter(entry => !/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(entry.path) || posix.dirname(entry.path) === "."
      || paths.some(path => path === posix.dirname(entry.path) || path.startsWith(`${posix.dirname(entry.path)}/`)))
    .sort((a, b) => Number(/AGENTS/.test(b.path)) - Number(/AGENTS/.test(a.path)) || distance(b.path) - distance(a.path) || a.path.length - b.path.length);
  const instructions = instructionCandidates.slice(0, 6).map(entry => ({ path: entry.path, sha256: entry.sha256 }));
  return { shared_entries, request_entries: ranked.slice(0, 5), examples, project_instructions: instructions,
    truncated: reusable.length > 8 || sharedUnreadable > 0 || moduleExamples.length > 3 || instructionCandidates.length > 6 || possible.length > 20 || ranked.length > 5 || unreadable > 0,
    request_truncated: possible.length > 20 || ranked.length > 5 || unreadable > 0, unreadable: unreadable + sharedUnreadable,
    next_step: "候选清单不等于已阅读或已掌握规范。编码前读取适用规范、相似实现与依赖用法，查询相关知识；用 task_open/task_update 的 implementation_basis 保存真实引用、约束、实现选择及其验收项。新目录无命中时继续全局检索，不能认定没有现成能力。" };
}
