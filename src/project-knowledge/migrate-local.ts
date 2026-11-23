import { z } from "zod";
import type { WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { IdSchema } from "../domain/common.js";
import { HASH, MAP_DIR } from "../understanding/contracts.js";
import { modelIndex, readIndexedModel, optional, save } from "../understanding/store.js";
import type { ProjectKnowledgeRepository } from "./repository.js";
import { publishModelShadow } from "./service.js";

const receiptPath = `${MAP_DIR}/migration-receipts.json`;
const Receipts = z.array(z.object({ id: IdSchema, hash: HASH, snapshot: HASH }).strict()).max(200);

/** 按本地模型内容和仍在共享事务链内的快照去重；回滚或重建共享库时会自动补迁。 */
export async function migrateLocalModels(binding: WorktreeBinding, repository: ProjectKnowledgeRepository) {
  const files = new ProjectFiles(binding.root), entries = await modelIndex(files);
  const migration = { attempted: 0, published: 0, reused: 0, failed: [] as string[] };
  if (!entries.length) return migration;
  const current = new Set(await repository.currentObjectIds());
  let receipts: z.infer<typeof Receipts> = [];
  try { receipts = Receipts.parse(JSON.parse(await optional(files, receiptPath) ?? "[]")); }
  catch { /* 回执只是加速记录，缺失或损坏时走原有幂等发布流程。 */ }
  const known = new Map(entries.map(item => [item.id, item.hash]));
  const valid = receipts.filter(item => known.get(item.id) === item.hash && current.has(item.snapshot));
  const reused = new Set(valid.map(item => item.id));
  migration.reused = reused.size;
  const pending = entries.filter(entry => !reused.has(entry.id));
  if (!pending.length) return migration;
  migration.attempted = pending.length;
  for (const entry of pending) {
    try {
      const model = await readIndexedModel(files, entry);
      const result = await publishModelShadow(binding, model as unknown as Record<string, unknown>);
      valid.push({ id: entry.id, hash: entry.hash, snapshot: result.snapshot_id });
      migration.published++;
    } catch (error) {
      migration.failed.push(`${entry.id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  }
  // 导入成功后才写回执；竞争或磁盘问题只会触发下一次幂等核验。
  if (migration.published) await save(files, receiptPath, valid).catch(() => {});
  return migration;
}
