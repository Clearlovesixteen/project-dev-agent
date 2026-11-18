import { z } from "zod";
import { AppError } from "../domain/error.js";
import { ProjectFiles } from "../storage/project-files.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { digest } from "../knowledge/document.js";
import { optional, save } from "../history/store.js";
import { FileSchema, HASH, MAP_DIR, MapSchema, SavedModelSchema, type MapFile, type SavedModel } from "./contracts.js";
import { IdSchema } from "../domain/common.js";

export { optional, save };
export async function locked<T>(files: ProjectFiles, action: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(files, `${MAP_DIR}/operation.lock`, "PROJECT_MAP_BUSY");
  try { return await action(); } finally { await release(); }
}
export async function readMap(files: ProjectFiles) {
  const raw = await optional(files, `${MAP_DIR}/manifest.json`);
  if (!raw) return undefined;
  const map = MapSchema.parse(JSON.parse(raw));
  if (map.project !== files.root) throw new AppError("PROJECT_MAP_MISMATCH", "项目结构索引属于另一个工作区");
  return map;
}
export async function mapFiles(files: ProjectFiles): Promise<MapFile[]> {
  const map = await readMap(files); if (!map) return [];
  const result: MapFile[] = [];
  for (const id of map.chunks) {
    const raw = await files.read(`${MAP_DIR}/chunks/${id}.json`, 65_536);
    if (digest(raw) !== id) throw new AppError("PROJECT_MAP_CORRUPT", "索引分块与其内容哈希不一致");
    result.push(...z.array(FileSchema).parse(JSON.parse(raw)));
  }
  return result;
}
const ModelsIndex = z.array(z.object({ id: IdSchema, revision: z.number().int().positive(), hash: HASH }).strict()).max(200);
export async function modelIndex(files: ProjectFiles) {
  return ModelsIndex.parse(JSON.parse(await optional(files, `${MAP_DIR}/models.json`) ?? "[]"));
}
export async function models(files: ProjectFiles): Promise<SavedModel[]> {
  const result: SavedModel[] = [];
  for (const entry of await modelIndex(files)) {
    const raw = await files.read(`${MAP_DIR}/models/${entry.hash}.json`, 65_536);
    if (digest(raw) !== entry.hash) throw new AppError("PROJECT_MODEL_CORRUPT", "模型内容与记录的哈希不一致");
    const model = SavedModelSchema.parse(JSON.parse(raw));
    if (model.project !== files.root || model.id !== entry.id || model.revision !== entry.revision) throw new AppError("PROJECT_MODEL_MISMATCH", "模型身份信息不匹配");
    result.push(model);
  }
  return result;
}
/** 将完整模型作为不可变文件落盘，再原子更新当前工作树的修订索引。调用方持有目录锁。 */
export async function publishModel(files: ProjectFiles, model: SavedModel): Promise<void> {
  const index = await modelIndex(files);
  const raw = JSON.stringify(model) + "\n", hash = digest(raw), path = `${MAP_DIR}/models/${hash}.json`;
  if (Buffer.byteLength(raw) > 65_536)
    throw new AppError("FILE_LIMIT", "模型超过 64 KiB，请按业务能力拆分并通过 target_model_id 复用公共模型");
  if (await optional(files, path) === undefined) await files.create(path, raw);
  const updated = [...index.filter(item => item.id !== model.id), { id: model.id, revision: model.revision, hash }];
  await save(files, `${MAP_DIR}/models.json`, updated);
}

export async function understandingStatus(files: ProjectFiles) {
  const map = await readMap(files);
  return { state: !map ? "not_scanned" : map.coverage.complete ? "indexed" : "partial", scan_id: map?.scan_id ?? null,
    scanned_at: map?.scanned_at ?? null, coverage: map?.coverage ?? null, model_count: (await modelIndex(files)).length,
    report: map ? `${MAP_DIR}/report.html` : null, freshness: "当前结果为快照；project_context 会核对选中来源的状态。新增文件需要重新扫描后才能发现。" };
}
