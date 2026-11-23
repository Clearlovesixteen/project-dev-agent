import type { materializeModel } from "../understanding/model-view.js";
import type { implementationContext } from "../quality/implementation-context.js";

type Role = "modify" | "reuse" | "protect" | "verify" | "inspect";
type Entry = { path: string; symbol?: string | undefined; reason: string; model_id?: string; rule_id?: string;
  binding_id?: string; acceptance_id?: string | undefined; caller?: string | undefined; check_id?: string };
type Group = { items: Entry[]; omitted: number };

/** 每个角色独享有限空间。词法、引用和模型关系都只能成为候选；只有当前任务的有效计划可列入 modify。 */
export class ImplementationView {
  private readonly locations: Record<Role, Group> = {
    modify: { items: [], omitted: 0 }, reuse: { items: [], omitted: 0 }, protect: { items: [], omitted: 0 },
    verify: { items: [], omitted: 0 }, inspect: { items: [], omitted: 0 },
  };
  private readonly seen = new Set<string>();
  private readonly gaps = new Set<string>();
  private readonly preserves: { model_id: string; rule_id: string; id: string; description: string; basis: string; freshness: string }[] = [];
  private preservesOmitted = 0;
  private inputKind: string | undefined;

  setInputKind(kind: string | undefined) { this.inputKind = kind; }
  gap(reason: string) { if (this.gaps.size < 12) this.gaps.add(reason); }

  add(role: Role, entry: Entry) {
    const key = JSON.stringify([role, entry.path, entry.symbol, entry.rule_id, entry.model_id, entry.binding_id, entry.check_id, entry.acceptance_id]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const group = this.locations[role];
    if (group.items.length >= 3 || Buffer.byteLength(JSON.stringify([...group.items, entry])) > 610) group.omitted++;
    else group.items.push(entry);
  }

  /** 已物化的规则带有逐条新鲜度。本次读取不会因一期模型或旧规则缺少绑定而失败。 */
  addModel(model: Awaited<ReturnType<typeof materializeModel>>, ruleIds: Set<string>, visible: (path: string) => boolean) {
    if (model.schema_version === 1) return;
    for (const rule of model.rules) {
      if (!ruleIds.has(rule.id)) continue;
      for (const item of rule.semantics?.preserves ?? []) {
        const entry = { model_id: model.id, rule_id: rule.id, id: item.id, description: item.description, basis: rule.basis, freshness: rule.freshness };
        if (this.preserves.length >= 3 || Buffer.byteLength(JSON.stringify([...this.preserves, entry])) > 500) this.preservesOmitted++;
        else this.preserves.push(entry);
      }
      for (const binding of rule.bindings ?? []) {
        if (!visible(binding.path)) continue;
        const current = rule.freshness === "current" && rule.binding_states?.some(state => state.id === binding.id && state.state === "current");
        const role = current && binding.role === "reuse" ? "reuse" : current && binding.role === "test" ? "verify" : "inspect";
        this.add(role, { path: binding.path, symbol: binding.symbol, model_id: model.id, rule_id: rule.id, binding_id: binding.id,
          reason: current ? "rule_binding" : "binding_needs_review" });
        if (!current) this.gap("rule_evidence_needs_review");
      }
    }
  }

  /** 优先展示统一封装的实际调用方，再补充当前仓库的复用和匹配线索。 */
  addRepository(context: Awaited<ReturnType<typeof implementationContext>>) {
    for (const item of [...context.request_entries.filter(item => item.role === "shared_request_entry"), ...context.shared_entries]) {
      if (item.source_state === "current") this.add("reuse", { path: item.path, reason: "repository_candidate", caller: item.consumers[0] });
    }
    for (const item of context.implementation_candidates?.candidates ?? []) this.add("inspect", {
      path: item.path, symbol: item.symbol ?? undefined, reason: item.match_reasons[0]?.kind ?? "repository_candidate",
      caller: item.consumers.find(caller => caller.source_state === "current")?.path,
    });
  }

  result() {
    return { schema_version: 1, input_kind: this.inputKind ?? "unclassified", ...this.locations, gaps: [...this.gaps],
      preserved_behaviors: { items: this.preserves, omitted: this.preservesOmitted },
      boundary: "modify 表示当前任务已登记且证据匹配的位置。实际写入仍需通过写前检查；其余位置只指导选读和验收。" };
  }
}
