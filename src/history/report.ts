import { ProjectFiles } from "../storage/project-files.js";
import { HISTORY_DIR } from "./contracts.js";
import { historyProfile, optional } from "./store.js";

export function escapeHtml(text: unknown): string {
  return String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export async function renderHistoryReport(files: ProjectFiles): Promise<string> {
  const profile = await historyProfile(files), m = profile.manifest;
  if (!m) return "";
  const e = escapeHtml;
  // Quotes stay in local batch records; the overview has bounded excerpts and source IDs.
  const cards = profile.hints.map((hint) => `<article><p class="eyebrow">${e(hint.audience === "personal" ? "个人偏好候选" : "项目规则候选")} · ${e(hint.type)}</p><h2>${e(hint.title)}</h2><p>${e(hint.rule.slice(0, 600))}</p><p class="muted">适用：${e(hint.applicable_conditions.join("；").slice(0, 400))}</p><p>${e(hint.rationale.slice(0, 250))}</p><p class="muted">最近依据：${e(hint.last_seen ?? "时间未知")} · 未确认</p>${hint.potential_conflicts.length ? '<p class="notice">同一主题存在不同时间的表述；结合当前代码核实，不以新旧顺序直接判定生效。</p>' : ""}<details><summary>原话与待核实项 · ${hint.evidence.length} 处引用 / ${hint.session_count} 个会话</summary>${hint.evidence.slice(0, 2).map((item) => `<blockquote>${e(item.quote.slice(0, 300))}<small>${e(item.source.timestamp)} · ${e(item.source.session)} · 第 ${item.source.line} 行</small></blockquote>`).join("")}<ul>${hint.review_questions.slice(0, 3).map((question) => `<li>${e(question.slice(0, 200))}</li>`).join("")}</ul><code>${e(hint.id)}</code></details></article>`);
  const pages: string[][] = [[]];
  for (const card of cards) {
    let page = pages[pages.length - 1]!;
    if (page.length >= 12 || Buffer.byteLength(page.join("") + card) > 36_000) { page = []; pages.push(page); }
    page.push(card);
  }
  const filename = (index: number) => index === 0 ? "report.html" : `report-${index + 1}.html`;
  // Publish the entry page last, after its linked pages exist.
  for (let index = pages.length - 1; index >= 0; index--) {
    const navigation = `<nav aria-label="报告分页">${index > 0 ? `<a href="${filename(index - 1)}">上一页</a> · ` : ""}第 ${index + 1} / ${pages.length} 页${index + 1 < pages.length ? ` · <a href="${filename(index + 1)}">下一页</a>` : ""}</nav>`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>项目习惯发现报告</title><style>body{margin:0;background:#f7f6f1;color:#213e33;font:15px/1.85 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}main{max-width:940px;margin:auto;padding:44px 24px}h1{font:600 38px/1.3 'Songti SC',serif}h2{font-size:21px;margin:6px 0 12px}.eyebrow{font-size:12px;color:#456b59;letter-spacing:1px}.muted,small{color:#637b70}small{display:block;font-size:11px;overflow-wrap:anywhere}.stats{display:flex;flex-wrap:wrap;gap:16px;margin:28px 0}.stat,article{background:#fffef9;border:1px solid #d7dfd3;border-radius:10px;padding:20px}.stat{flex:1;min-width:130px}.stat b{display:block;font-size:30px}article{margin:20px 0;break-inside:avoid}.notice{border-left:3px solid #a87827;padding:10px 16px;background:#f0ebdc}blockquote{margin:15px 0;padding:10px 16px;border-left:2px solid #8aa58c}summary{cursor:pointer}code{font-size:12px;overflow-wrap:anywhere}li{overflow-wrap:anywhere}@media print{body{background:white}main{padding:0}details{display:block}}@media(max-width:600px){h1{font-size:30px}.stats{gap:8px}.stat{min-width:100px}}</style></head><body><main><p class="eyebrow">PROJECT DEV · HISTORY DISCOVERY</p><h1>项目习惯发现报告</h1><p class="muted">${e(m.project)}<br>扫描时间：${e(m.scanned_at)}</p><div class="stats"><div class="stat"><b>${m.coverage.project_sessions}</b>项目用户会话</div><div class="stat"><b>${profile.analyzed} / ${m.batches.length}</b>已分析文本批次</div><div class="stat"><b>${profile.hints.length}</b>习惯与规则候选</div></div><p class="notice">${profile.pending.length ? "分析尚未完成，以下为已处理批次的阶段结果。" : "当前快照的可读文本批次已处理。"} ${m.coverage.source_complete ? "" : "部分来源未能读取，不能视为全部历史完成。"} 所有结论保留为候选，需要结合现有代码核实；历史原话不会自动成为共享规则。</p><p>扫描 ${m.coverage.files_discovered} 个本地日志；排除 ${m.coverage.internal_sessions_excluded} 个项目内部代理记录、${m.coverage.other_projects_excluded} 个其他项目记录、${m.coverage.duplicate_sessions_excluded} 个重复会话。提取 ${m.coverage.user_messages} 条用户消息、${m.coverage.assistant_messages} 条助手可见回复；${m.coverage.attachment_messages} 条消息含附件，附件内容未在此次文本分析中解析。屏蔽 ${m.coverage.redactions} 处疑似凭据。</p>${m.diagnostics.length ? `<details><summary>来源与读取说明</summary><ul>${m.diagnostics.slice(0, 10).map((item) => `<li>${e(item.code.slice(0, 80))}：${e(item.message.slice(0, 200))}</li>`).join("")}</ul></details>` : ""}${navigation}${pages[index]!.join("") || "<article><p>尚无习惯候选。已分析批次未发现可复用偏好时可以保留空结果。</p></article>"}${navigation}<p class="muted">所有候选均可翻页查看。长内容显示摘要，完整记录及读取诊断保存在本地 analysis 和 manifest.json 中。</p><footer><p class="muted">本报告含私人历史摘录，保存在 Git 忽略的本地目录。分析由当前 Codex 会话完成，软件仅记录来源、覆盖和候选结果。扫描快照之后的新增消息将在下次扫描时处理。</p></footer></main></body></html>`;
    const target = `${HISTORY_DIR}/${filename(index)}`;
    const prior = await optional(files, target);
    if (prior === undefined) await files.create(target, html); else await files.replace(target, html, prior);
  }
  return `${HISTORY_DIR}/report.html`;
}
