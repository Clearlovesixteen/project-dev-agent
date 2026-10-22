import type { MapFile } from "../understanding/contracts.js";
import type { ProjectConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import { safeSource } from "../understanding/scan.js";
import { HTTP_LIBRARIES, httpUsage, codeMask } from "./http-usage.js";

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
  const moduleExamples = entries.filter(entry => programFile(entry.path) && inScope(entry.path) && entry.role !== "test" && !ranked.some(candidate => candidate.path === entry.path))
    .sort((a, b) => Number(/(?:modules|features|pages|views)\//.test(b.path)) - Number(/(?:modules|features|pages|views)\//.test(a.path)) || a.path.localeCompare(b.path));
  const examples = [...new Set([...ranked.slice(0, 3).flatMap(entry => entry.consumers), ...moduleExamples.map(entry => entry.path)])].slice(0, 3).map(path => ({ path, reason: "阅读已有业务模块怎样调用公共能力，沿用其分层、参数和错误处理。" }));
  const instructions = entries.filter(entry => /(?:^|\/)(?:AGENTS|CLAUDE|README|ARCHITECTURE|CONTRIBUTING|conventions|coding[-_]style)\.(?:md|html)$/i.test(entry.path))
    .sort((a, b) => Number(/AGENTS/.test(b.path)) - Number(/AGENTS/.test(a.path)) || a.path.length - b.path.length).slice(0, 6).map(entry => ({ path: entry.path, sha256: entry.sha256 }));
  return { request_entries: ranked.slice(0, 5), examples, project_instructions: instructions,
    truncated: possible.length > 20 || ranked.length > 5 || unreadable > 0, unreadable,
    next_step: "编码前实际阅读公共入口、至少一个现有业务用法及适用项目规范，再记录职责、复用选择与设计理由。独立业务模块继续复用项目基础设施；只有确认缺口后才新增底层实现。没有候选不等于项目没有封装，必要时继续全局检索。" };
}
