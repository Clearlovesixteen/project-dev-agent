import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RuntimeSettings, runtimeFiles } from "../runtime/config.js";
import { DiagnosticWriter } from "../observability/writer.js";
import { hasCode } from "../storage/project-files.js";
import { acquireFileLock } from "../storage/file-lock.js";
import type { InteractionContext } from "../workflow/interaction.js";

const ROOT = "project-dev-agent/contexts";
const Receipt = z.object({ generation: z.uuid(), context_id: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  issued_at: z.number(), turn_id: z.string().max(200).nullable() }).strict();

/** 回执只保存摘要指纹和生命周期，不保存上下文、提问或项目路径；不能把自报 ID 算成有效注入。 */
export class ContextReceipts {
  private readonly settings: RuntimeSettings;
  constructor(home?: string) { this.settings = new RuntimeSettings(home); }
  private async path(project: string, interaction: InteractionContext) {
    const id = await new DiagnosticWriter(this.settings.home).opaque(JSON.stringify([project, interaction.session_id, interaction.actor_id ?? "main"]));
    return `${ROOT}/${id}.json`;
  }
  async reset(project: string, interaction: InteractionContext) {
    return this.issue(project, interaction, null, true);
  }
  async issue(project: string, interaction: InteractionContext, contextId: string | null, reset = false) {
    const files = await runtimeFiles(this.settings.home), path = await this.path(project, interaction);
    await files.directory(ROOT);
    const release = await acquireFileLock(files, `${path}.lock`, "CONTEXT_RECEIPT_BUSY");
    try {
      let raw: string | undefined;
      try { raw = await files.read(path); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      const previous = raw ? Receipt.parse(JSON.parse(raw)) : undefined;
      const now = Date.now();
      const duplicate = !reset && previous?.context_id === contextId && now - previous.issued_at < 5 * 60_000;
      const receipt = { generation: reset || !previous ? randomUUID() : previous.generation,
        context_id: contextId, issued_at: now, turn_id: interaction.turn_id ?? null };
      if (raw === undefined) await files.create(path, JSON.stringify(receipt)); else await files.replace(path, JSON.stringify(receipt), raw);
      return { duplicate, generation: receipt.generation };
    } finally { await release(); }
  }
  async valid(project: string, interaction: InteractionContext) {
    if (!interaction.context_id) return false;
    try {
      const files = await runtimeFiles(this.settings.home), receipt = Receipt.parse(JSON.parse(await files.read(await this.path(project, interaction))));
      return receipt.context_id === interaction.context_id && Date.now() - receipt.issued_at <= 30 * 60_000;
    } catch { return false; }
  }
}
