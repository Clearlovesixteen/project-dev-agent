import { ProjectFiles } from "../storage/project-files.js";
import { escapeHtml as e } from "../history/report.js";
import { mapFiles, models, optional, readMap } from "./store.js";
import { MAP_DIR } from "./contracts.js";
import { moduleSummary } from "./context.js";
import { fileRoleLabel, responsibilityLabels } from "../report-labels.js";

export async function renderProjectReport(files: ProjectFiles): Promise<string> {
  const map = await readMap(files); if (!map) return "";
  const entries = await mapFiles(files), candidates = await models(files), modules = moduleSummary(entries);
  const cards = [
    ...candidates.map((model) => `<article><small>模块理解候选 · 修订 ${model.revision}</small><h2>${e(model.title)}</h2><p>${e(model.summary)}</p><p>范围：${e(model.scope.join("，"))}</p><details><summary>术语、流程、依据与待核实项</summary><ul>${model.entities.map((item) => `<li>${e(item.name)}：${e(item.meaning)}</li>`).join("")}${model.flows.map((item) => `<li>${e(item.name)}：${e(item.steps.join(" → "))}</li>`).join("")}${model.rules.map((item) => `<li>${e(responsibilityLabels[item.responsibility])}：${e(item.description)}</li>`).join("")}</ul>${model.sources.map((source) => `<blockquote>${e(source.quote)}<small>${e(source.path)}:${source.line} · ${e(source.sha256.slice(0, 12))}</small></blockquote>`).join("")}<ul>${model.questions.map((item) => `<li>${e(item)}</li>`).join("")}</ul></details></article>`),
    ...modules.map((module) => `<article><small>目录或配置推测的模块边界</small><h2>${e(module.module)}</h2><p>${module.files} 个索引文件 · ${e(Object.entries(module.roles).map(([role, count]) => `${fileRoleLabel(role)} ${count}`).join(" / "))}</p><p>${module.examples.map((path) => `<code>${e(path)}</code>`).join("<br>")}</p></article>`),
    ...entries.map((file) => `<article><small>${e(fileRoleLabel(file.role))} · ${e(file.module)}</small><h2>${e(file.path)}</h2><p>${file.bytes} 字节 · ${e(file.sha256.slice(0, 12))}</p>${file.package ? `<details><summary>依赖声明和可用脚本（没有执行）</summary><p>${e(file.package.dependencies.map((item) => `${item.name}: ${item.declared}`).join("；"))}</p><p>${e(file.package.scripts.join("，"))}${file.package.truncated ? " · 声明摘要有截取" : ""}</p><p>声明版本不等于实际安装产物，组件能力仍需查当前实现。</p></details>` : ""}${file.imports.length ? `<details><summary>${file.imports.length} 条导入线索${file.imports_truncated ? "（已截取）" : ""}</summary><ul>${file.imports.map((item) => `<li>${e(item.specifier)} → ${e(item.target ?? "未解析 / 外部依赖")} · 第 ${item.line} 行</li>`).join("")}</ul></details>` : ""}</article>`),
  ];
  const pages: string[][] = [[]];
  for (const original of cards) {
    const card = Buffer.byteLength(original) > 48_000 ? `<article>${original.match(/<h2>[\s\S]*?<\/h2>/)?.[0] ?? "<h2>超长记录</h2>"}<p>此条完整内容超过单页展示上限，保留于本地 chunks 或 models JSON 中；请通过 project_context 缩小范围查询。</p></article>` : original;
    let page = pages[pages.length - 1]!;
    if (page.length >= 30 || Buffer.byteLength(page.join("") + card) > 48_000) { page = []; pages.push(page); }
    page.push(card);
  }
  const name = (index: number) => index ? `report-${index + 1}.html` : "report.html";
  for (let index = pages.length - 1; index >= 0; index--) {
    const nav = `<nav aria-label="报告分页">${index ? `<a href="${name(index - 1)}">上一页</a> · ` : ""}第 ${index + 1} / ${pages.length} 页${index + 1 < pages.length ? ` · <a href="${name(index + 1)}">下一页</a>` : ""} · <a href="report.html">首页</a></nav>`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>项目结构与业务理解</title><style>body{margin:0;background:#f7f6f1;color:#213e33;font:15px/1.9 system-ui}main{max-width:960px;margin:auto;padding:40px 24px}h1{font:600 36px/1.4 serif}h2{font-size:19px;overflow-wrap:anywhere}article{background:#fffef9;border:1px solid #d7dfd3;border-radius:10px;padding:22px;margin:20px 0}small{display:block;color:#647d6e;overflow-wrap:anywhere}code,li,p{overflow-wrap:anywhere}nav{margin:24px 0}a{color:#215847}.notice,blockquote{border-left:3px solid #9cae87;padding:12px 18px;background:#eaf0e5}blockquote{white-space:pre-wrap}summary{cursor:pointer}@media(max-width:600px){main{padding:24px 16px}h1{font-size:28px}}@media print{article{break-inside:avoid}}</style></head><body><main><small>项目开发 · 结构与业务理解</small><h1>项目结构与业务理解</h1><p>${e(map.project)}<br>结构快照：${e(map.scanned_at)}</p><p>${map.coverage.indexed} 个索引文件 · ${modules.length} 个模块线索 · ${candidates.length} 个业务理解候选</p><p class="notice">${map.coverage.complete ? "支持范围内的结构扫描已完成。" : "结构扫描有未覆盖来源，请查看诊断。"}这是结构索引和按需记录的理解，不表示已读懂全项目业务。导入关系只提供检查线索；业务模型需要核实。此报告是生成时快照，使用前通过 project_context 检查源码版本。</p><p>Git 枚举 ${map.coverage.discovered} 条路径；排除 ${map.coverage.excluded} 条，不支持格式 ${map.coverage.unsupported} 条，无法读取 ${map.coverage.unreadable} 条，复用提取结果 ${map.coverage.reused} 条。未解析动态调用、配置继承、跨仓库和运行时关系。</p>${index === 0 && map.diagnostics.length ? `<details><summary>扫描诊断（前 10 条，全部见 manifest.json）</summary><ul>${map.diagnostics.slice(0, 10).map((item) => `<li>${e(item.code)}：${e(item.message.slice(0, 200))}</li>`).join("")}</ul></details>` : ""}${nav}${pages[index]!.join("") || "<p>尚无可索引文件。</p>"}${nav}<p>记录保存在 Git 忽略目录。页面按顺序展示业务候选、模块概览和全部索引文件；未执行项目代码或脚本。</p></main></body></html>`;
    const path = `${MAP_DIR}/${name(index)}`, prior = await optional(files, path);
    if (prior === undefined) await files.create(path, html); else await files.replace(path, html, prior);
  }
  return `${MAP_DIR}/report.html`;
}
