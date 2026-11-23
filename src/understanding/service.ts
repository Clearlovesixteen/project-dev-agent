import { opendir } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import type { ToolResult } from "../domain/result.js";
import { assertStateIgnored, type WorktreeBinding } from "../git/index.js";
import { ProjectFiles } from "../storage/project-files.js";
import { MAP_DIR, ModelRecordInput, ScanInput } from "./contracts.js";
import { locked, models, publishModel, understandingStatus } from "./store.js";
import { scanProject } from "./scan.js";
import { projectContext } from "./context.js";
import { provideContext } from "../context/provider.js";
import { renderProjectReport } from "./report.js";
import { buildModel } from "./model-record.js";
import type { ModuleSnapshot } from "../project-knowledge/view-resolver.js";
import { publishModelShadow, readProjectKnowledge } from "../project-knowledge/service.js";
import { modelVisible, readWorktreeModels, worktreeModel } from "../project-knowledge/worktree-models.js";
import { loadConfig } from "../knowledge/config.js";
import { SavedModelSchema } from "./model-contracts.js";
import { commonSnapshot, mergeModelPatch } from "./model-merge.js";

const MODEL_SYNC_DIR = ".project-dev/local/model-sync";
const ModelSyncMarkerSchema = z.object({
  schema_version: z.literal(1), state: z.enum(["pending", "resolved"]), model_id: z.string().min(1),
  revision: z.number().int().positive(), snapshot_id: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.unknown().optional(), created_at: z.string().datetime({ offset: true }),
  resolved_at: z.string().datetime({ offset: true }).optional(), last_error: z.string().max(500).optional(),
}).strict();
type ModelSyncMarker = z.infer<typeof ModelSyncMarkerSchema>;

async function readModelSyncMarker(files: ProjectFiles, path: string): Promise<ModelSyncMarker | undefined> {
  try { return ModelSyncMarkerSchema.parse(JSON.parse(await files.read(path, 1_048_576))); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

async function writeModelSyncMarker(files: ProjectFiles, modelId: string, marker: ModelSyncMarker): Promise<void> {
  await files.directory(MODEL_SYNC_DIR);
  const path = `${MODEL_SYNC_DIR}/${modelId}.json`, content = `${JSON.stringify(ModelSyncMarkerSchema.parse(marker))}\n`, previous = await readModelSyncMarker(files, path);
  if (!previous) await files.create(path, content, 1_048_576);
  else await files.replace(path, content, JSON.stringify(previous) + "\n", 1_048_576);
}

/** 共享快照已提交而本地索引失败时，在下次模型写入前补偿本地发布。 */
async function recoverModelSync(files: ProjectFiles): Promise<{ code: string; message: string }[]> {
  const diagnostics: { code: string; message: string }[] = [];
  let directory;
  try { directory = await opendir(await files.path(MODEL_SYNC_DIR)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return diagnostics; throw error; }
  let count = 0;
  for await (const entry of directory) {
    if (++count > 100) { diagnostics.push({ code: "PROJECT_MODEL_SYNC_LIMIT", message: "待恢复的模型发布记录超过100条，请分批处理" }); break; }
    if (!entry.name.endsWith(".json")) continue;
    const path = `${MODEL_SYNC_DIR}/${entry.name}`;
    try {
      const marker = await readModelSyncMarker(files, path);
      if (!marker || marker.state === "resolved") continue;
      const model = SavedModelSchema.safeParse(marker.model);
      if (!model.success) throw new AppError("PROJECT_MODEL_SYNC_CORRUPT", `待恢复模型内容无效：${marker.model_id}`);
      const existing = (await models(files)).find(item => item.id === marker.model_id);
      // 同一修订号也要核对正文。并行工作树可能生成同 revision 的不同候选，
      // 不能因数字相同就把待恢复标记误判为已落盘。
      if (!existing || existing.revision !== marker.revision || JSON.stringify(existing) !== JSON.stringify(model.data))
        await publishModel(files, model.data);
      const { model: _model, ...resolved } = marker;
      await writeModelSyncMarker(files, marker.model_id, { ...resolved, state: "resolved", resolved_at: new Date().toISOString() });
    } catch (error) {
      diagnostics.push({ code: "PROJECT_MODEL_SYNC_PENDING", message: `模型 ${entry.name.slice(0, -5)} 的本地发布仍待恢复：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return diagnostics;
}

/** 管理结构扫描与业务理解候选；语义内容由 Codex 提交，服务负责核对来源和版本。 */
export class UnderstandingService {
  private readonly files: ProjectFiles;
  constructor(private readonly binding: WorktreeBinding) { this.files = new ProjectFiles(binding.root); }
  private async execute(action: () => Promise<ToolResult>): Promise<ToolResult> {
    try { return await action(); } catch (error) {
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "PROJECT_UNDERSTANDING_INPUT" : "PROJECT_UNDERSTANDING_FAILED";
      return { outcome: "error", code, diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] };
    }
  }
  /** 在本地忽略目录发布结构索引和报告，扫描与模型写入共用锁，避免状态交叉覆盖。 */
  async scan(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      ScanInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const map = await scanProject(this.binding); await renderProjectReport(this.files);
        return { outcome: map.coverage.complete ? "ok" : "incomplete", code: "PROJECT_SCANNED", data: await understandingStatus(this.files), diagnostics: map.diagnostics };
      });
    });
  }
  /** 查询时核验所选来源；需要重扫或覆盖不完整时返回 incomplete，供调用方补充检查。 */
  async context(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const data = await provideContext(this.files, input);
      const shared = data.project_knowledge;
      const sharedIncomplete = shared && !["not_initialized", "empty", "matched"].includes(shared.state);
      const incomplete = ["needs_rescan", "needs_review", "partial"].includes(data.state) || sharedIncomplete;
      return { outcome: incomplete ? "incomplete" : "ok", code: "PROJECT_CONTEXT", data,
        diagnostics: incomplete ? [{ code: sharedIncomplete ? "PROJECT_KNOWLEDGE_REVIEW_PENDING" : "PROJECT_CONTEXT_NEEDS_REVIEW",
          message: shared?.message ?? (sharedIncomplete ? "部分业务模型缺少唯一适用的证据。已核验的规则和源码入口仍可分别查看。"
            : "请核对待复核条目，按需重新扫描当前项目。") }] : [] };
    });
  }
  /** 保存有源码依据的模型候选；引用匹配只证明来源，不把语义结论自动确认为规则。 */
  async record(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      let request = ModelRecordInput.parse(input); await assertStateIgnored(this.binding);
      return locked(this.files, async () => {
        const recoveryDiagnostics = await recoverModelSync(this.files);
        const snapshotById = new Map<string, ModuleSnapshot>();
        const currentKnowledge = await readProjectKnowledge(this.binding, { reviewedSnapshots: snapshotById });
        if (request.knowledge_view_token && request.knowledge_view_token !== currentKnowledge.view_token)
          throw new AppError("PROJECT_KNOWLEDGE_VIEW_STALE", "共享项目知识视图已变化，请重新查询 project_context 后再记录模型");
        if (currentKnowledge.state === "unavailable" || currentKnowledge.state === "needs_review" && !currentKnowledge.view_token)
          throw new AppError("PROJECT_KNOWLEDGE_UNAVAILABLE", "项目知识视图暂无法核验，请恢复后再修订模型");
        const selection = currentKnowledge.modules?.find(item => item.model_id === request.id);
        if (selection?.state === "partial")
          throw new AppError("PROJECT_KNOWLEDGE_SOURCE_INCOMPLETE", "当前模型来源覆盖不足，请补齐来源后再修订");
        if (selection?.state === "ambiguous" && !request.base_snapshot_id)
          throw new AppError("PROJECT_MODEL_REVIEW_REQUIRED", "当前模型存在多个候选；请核对源码并指定修订基线");
        const { config } = await loadConfig(this.files);
        const shared = await readWorktreeModels(this.files, currentKnowledge);
        const existing = shared.models.filter(model => modelVisible(model, config));
        const reviewed = [...new Set([request.base_snapshot_id, ...request.reviewed_snapshot_ids ?? []]
          .filter((id): id is string => !!id))];
        let nextRevision = request.expected_revision + 1;
        let reviewedParents: typeof existing = [];
        if (reviewed.length) {
          // 只沿本次已校验事务中的父链遍历，避免每走一层重新打开仓库并扫描整个对象索引。
          const load = async (id: string) => {
            const snapshot = snapshotById.get(id);
            if (snapshot?.model_id !== request.id)
              throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "此快照不属于当前项目事务及指定业务模型");
            return snapshot;
          };
          const parents = await Promise.all(reviewed.map(async id => {
            const snapshot = await load(id);
            const model = worktreeModel(this.binding.root, snapshot.content, request.id);
            if (!model || !modelVisible(model, config))
              throw new AppError("PROJECT_MODEL_SNAPSHOT_UNKNOWN", "复核快照内容不在当前项目可用范围");
            return model;
          }));
          if (parents.length > 1) {
            const ancestor = await commonSnapshot(reviewed, load);
            const base = worktreeModel(this.binding.root, ancestor.content, request.id);
            const modern = parents.filter(parent => parent.schema_version !== 1);
            if (!base || base.schema_version === 1 || modern.length !== parents.length || !modelVisible(base, config))
              throw new AppError("PROJECT_MODEL_MERGE_BASE", "合并必须使用可见且具备稳定规则 ID 的共同基线及父快照");
            request = mergeModelPatch(request, base, modern);
            reviewedParents = modern.slice(1);
          }
          const local = existing.findIndex(model => model.id === request.id);
          if (local >= 0) existing.splice(local, 1);
          existing.push(parents[0]!);
          nextRevision = Math.max(nextRevision, ...parents.map(parent => parent.revision + 1));
        } else if (shared.snapshotIds.has(request.id)) {
          reviewed.push(shared.snapshotIds.get(request.id)!);
        }
        const model = await buildModel(this.files, this.binding, request, existing, nextRevision, reviewedParents);
        const serialized = model as unknown as Record<string, unknown>;
        const prior = existing.find(entry => entry.id === request.id);
        const persisted = await publishModelShadow(this.binding, serialized, {
          expected_transaction_id: currentKnowledge.transaction_id ?? null,
          ...(reviewed.length ? { parent_snapshot_ids: reviewed } : {}),
          ...(prior ? { base_model: prior as unknown as Record<string, unknown> } : {}),
        });
        const diagnostics: { code: string; message: string }[] = [...recoveryDiagnostics];
        let markerWritten = false;
        try {
          await writeModelSyncMarker(this.files, model.id, {
            schema_version: 1, state: "pending", model_id: model.id, revision: model.revision,
            snapshot_id: persisted.snapshot_id, model, created_at: new Date().toISOString(),
          });
          markerWritten = true;
        } catch (error) {
          diagnostics.push({ code: "PROJECT_MODEL_SYNC_MARKER_UNAVAILABLE", message: `共享修订已保存，但本地恢复标记暂时不可写：${error instanceof Error ? error.message : String(error)}` });
        }
        try {
          await publishModel(this.files, model);
          if (markerWritten) {
            const marker = await readModelSyncMarker(this.files, `${MODEL_SYNC_DIR}/${model.id}.json`);
            if (marker) {
              const { model: _model, ...resolved } = marker;
              await writeModelSyncMarker(this.files, model.id, { ...resolved, state: "resolved", resolved_at: new Date().toISOString() });
            }
          }
        }
        catch (error) { diagnostics.push({ code: "PROJECT_MODEL_LOCAL_CACHE_UNAVAILABLE", message: `共享修订已保存，工作树副本暂时不可写，可通过 project_context 读取。${error instanceof Error ? `（${error.message}）` : ""}` }); }
        let current: Awaited<ReturnType<typeof projectContext>> | undefined;
        try {
          current = await projectContext(this.files, { model_id: model.id });
          await renderProjectReport(this.files);
        } catch { diagnostics.push({ code: "PROJECT_REPORT_UNAVAILABLE", message: "共享修订已保存，工作树报告暂时无法生成，可通过 project_context 读取。" }); }
        const view = current?.models[0];
        return { outcome: "ok", code: "PROJECT_MODEL_RECORDED", data: { id: model.id, revision: model.revision, snapshot_id: persisted.snapshot_id,
          model_audit: current && "model_audit" in current ? current.model_audit : undefined,
          status: view?.status ?? "needs_review", effective: false, schema_version: model.schema_version,
          ...(view && "review_required" in view ? { review_required: view.review_required } : {}),
          report: `${MAP_DIR}/report.html`, next_step: "模型已保存；未复核条目继续保留旧依据。引用匹配不证明业务判断正确，也不代表用户或团队批准。" }, diagnostics };

      });
    });
  }
}
