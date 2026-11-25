import { z } from "zod";
import { readdir } from "node:fs/promises";
import type { Task } from "../domain/task.js";
import { AppError } from "../domain/error.js";
import {
  assertBaseline,
  assertStateIgnored,
  type WorktreeBinding,
} from "../git/index.js";
import { reviewSnapshot } from "../git/review-snapshot.js";
import { digest } from "../knowledge/document.js";
import { loadConfig } from "../knowledge/config.js";
import { ProjectFiles } from "../storage/project-files.js";
import { MAP_DIR } from "../understanding/contracts.js";
import {
  ModelEvidence,
  ruleFingerprint,
  sourceFingerprint,
  sourcePath,
} from "../understanding/model-evidence.js";
import { recordModel } from "../understanding/model-record.js";
import { CodeBindingResolver } from "../understanding/code-bindings.js";
import { assertEnhancedModelWrites } from "../runtime/business-model-release.js";
import { evaluateRule } from "../understanding/rule-predicates.js";
import {
  SavedModelSchema,
  type ModernModel,
  type SavedModel,
} from "../understanding/model-contracts.js";
import {
  locked,
  mapFiles,
  modelIndex,
  models,
  optional,
  readMap,
  save,
} from "../understanding/store.js";
import {
  BusinessDeltaInputSchema,
  BusinessDeltaApplyInputSchema,
  BusinessDeltaReceiptSchema,
  enhancedBusinessDelta,
  type BusinessDeltaInput,
  type BusinessDeltaRecord,
  type BusinessDeltaReceipt,
} from "./business-delta-contracts.js";
import { publishModelShadow, readModelSnapshot, readProjectKnowledge } from "../project-knowledge/service.js";
import { loadWorktreeModels, modelVisible, worktreeModel } from "../project-knowledge/worktree-models.js";
import { checkScenarioRetirements } from "../understanding/scenario-retirement.js";
import { SavedRuleV3 } from "../understanding/model-contracts.js";

export type BusinessDeltaTask = Pick<
  Task,
  | "id"
  | "repo_identity"
  | "worktree_path"
  | "baseline_head"
  | "baseline_branch"
  | "workspace_baseline"
  | "requirement"
  | "corrections"
  | "acceptance_criteria"
> & { business_deltas?: BusinessDeltaRecord[] | undefined };
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const fingerprint = (
  input: BusinessDeltaInput,
  before: BusinessDeltaRecord["before_rule"],
  base?: string,
) => digest(JSON.stringify(base ? [input, before, base] : [input, before]));
const activeDeltas = (task: BusinessDeltaTask) =>
  (task.business_deltas ?? []).filter(
    (record) =>
      !task.business_deltas?.some(
        (other) => other.input.supersedes_id === record.input.id,
      ),
  );
const receiptPath = (task: BusinessDeltaTask, record: BusinessDeltaRecord) =>
  `${MAP_DIR}/business-deltas/${task.id}/${record.fingerprint}.json`;
const AttemptSchema = z
  .object({
    input_hash: z.string(),
    marker: z.string(),
    review_snapshot: z.string(),
    expected_revision: z.number().int().positive(),
    published_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    revalidation_only: z.boolean().optional(),
  })
  .strict();
const JournalSchema = z
  .object({
    receipt: BusinessDeltaReceiptSchema.optional(),
    receipt_history: z.array(BusinessDeltaReceiptSchema).max(40).default([]),
    pending: AttemptSchema.optional(),
    abandoned_attempts: z.array(AttemptSchema).max(40).default([]),
  })
  .strict();

function assertBinding(
  binding: WorktreeBinding,
  task: BusinessDeltaTask,
): void {
  if (
    binding.root !== task.worktree_path ||
    binding.repo_identity !== task.repo_identity
  )
    throw new AppError(
      "BUSINESS_DELTA_SCOPE",
      "业务草案必须属于当前项目及工作区",
    );
}
function requireModel(all: SavedModel[], id: string): ModernModel {
  const model = all.find((item) => item.id === id);
  if (!model || model.schema_version === 1)
    throw new AppError(
      "BUSINESS_DELTA_MODEL",
      "业务变更需要当前项目已有的新版模型",
    );
  return model;
}
function assertUnchanged(model: ModernModel, record: BusinessDeltaRecord): void {
  const current = model.rules.find((rule) => rule.id === record.input.rule_id);
  if (
    record.input.operation === "add"
      ? !!current
      : !same(current, record.before_rule)
  )
    throw new AppError(
      "BUSINESS_DELTA_CONFLICT",
      "目标规则已变化，请读取最新模型并追加修订草案，不能覆盖",
    );
}
/** 预期变更有独立场景标识，不能拿当前模型的 observed 场景替代。结果不截断。 */
export function businessDeltaScenarios(record: BusinessDeltaRecord) {
  const rule = record.input.proposed_rule ?? record.before_rule;
  const semantic = record.input.proposed_rule?.semantics;
  const definitions: { kind: string; text: string; case_id?: string; preserve_id?: string }[] =
    record.input.operation === "remove"
      ? [{ kind: "retirement", text: `停用规则：${rule!.description}` }]
      : semantic ? [
        ...semantic.cases.map(item => ({ kind: item.expected, text: item.description, case_id: item.id })),
        ...semantic.preserves.map(item => ({ kind: "preserve", text: item.description, preserve_id: item.id })),
      ]
      : [
          { kind: "normal", text: rule!.conditions.join("；") },
          ...rule!.conditions.map((text) => ({ kind: "boundary", text })),
          ...rule!.exceptions.map((text) => ({ kind: "exception", text })),
        ];
  for (const item of record.input.scenario_retirements ?? []) definitions.push({ kind: "retirement",
    text: `核对${item.kind}/${item.id} 的退役：${item.reason}${item.replacement_id ? `；替代场景 ${item.replacement_id}` : ""}` });
  return definitions.map((definition, index) => ({
    kind: definition.kind,
    ...(definition.case_id ? { case_id: definition.case_id } : {}),
    ...(definition.preserve_id ? { preserve_id: definition.preserve_id } : {}),
    description: definition.text,
    expected_rule:
      record.input.operation === "remove"
        ? "原行为已停用，关联入口及边界按需求核对"
        : rule!.description,
    business_delta_check: {
      delta_id: record.input.id,
      delta_fingerprint: record.fingerprint,
      scenario_id: `delta-scenario-${digest(
        JSON.stringify([index, definition]),
      ).slice(0, 24)}`,
    },
  }));
}
function assertAcceptance(
  task: BusinessDeltaTask,
  record: BusinessDeltaRecord,
  snapshot: string,
): void {
  const criteria = record.input.acceptance_ids.map((id) =>
    task.acceptance_criteria.find((candidate) => candidate.id === id),
  );
  for (const [index, item] of criteria.entries()) {
    if (
      !item ||
      item.status !== "checked" ||
      item.review_snapshot !== snapshot ||
      !item.evidence.length
    )
      throw new AppError(
        "BUSINESS_DELTA_ACCEPTANCE",
        `业务变更需在当前代码上完成关联验收：${record.input.acceptance_ids[index]}`,
      );
  }
  for (const scenario of businessDeltaScenarios(record)) {
    if (
      !criteria.some(
        (item) =>
          item?.business_delta_check &&
          same(item.business_delta_check, scenario.business_delta_check),
      )
    )
      throw new AppError(
        "BUSINESS_DELTA_SCENARIO",
        "业务变更正常、条件边界及例外场景须逐项绑定当前草案指纹并实际验收，不能只填写无关验收 ID",
      );
  }
}
async function evidenceFor(
  files: ProjectFiles,
  binding: WorktreeBinding,
  task: BusinessDeltaTask,
) {
  const { config } = await loadConfig(files);
  // 临时任务快照只用于核对需求原文；不把传入对象视为用户或团队批准。
  return new ModelEvidence(
    files,
    config,
    new Map((await mapFiles(files)).map((entry) => [entry.path, entry])),
    binding.repo_identity,
    new Map([[task.id, task as Task]]),
  );
}

/** 草案追加到任务，保留旧规则前镜像；需求预期不会提前覆盖有效模型。 */
export async function recordBusinessDeltas(
  binding: WorktreeBinding,
  task: BusinessDeltaTask,
  values: unknown[],
): Promise<BusinessDeltaRecord[]> {
  assertBinding(binding, task);
  const inputs = values.map((value) => BusinessDeltaInputSchema.parse(value));
  assertEnhancedModelWrites(inputs.some(enhancedBusinessDelta));
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length)
    throw new AppError("BUSINESS_DELTA_DUPLICATE", "本次草案 ID 不能重复");
  const files = new ProjectFiles(binding.root);
  const { knowledge, models: all, snapshotIds } = await loadWorktreeModels(binding, files);
  if (knowledge.state === "unavailable") throw new AppError("PROJECT_KNOWLEDGE_UNAVAILABLE", "共享业务模型暂无法核验，请重新查询当前项目");
  const evidence = await evidenceFor(files, binding, task);
  const history = [...(task.business_deltas ?? [])];
  for (const raw of inputs) {
    const old = history.find((record) => record.input.id === raw.id);
    if (old) {
      // 服务补充过的任务来源哈希不要求调用方重复填写；其余内容必须完全一致。
      const normalize = (input: BusinessDeltaInput) => ({
        ...input,
        sources: input.sources.map((source) =>
          source.kind === "task" ? { ...source, sha256: undefined } : source,
        ),
      });
      if (!same(normalize(old.input), normalize(raw)))
        throw new AppError(
          "BUSINESS_DELTA_IMMUTABLE",
          "已有草案不能覆盖；使用新 ID 和 supersedes_id 追加修订",
        );
      continue;
    }
    if (
      raw.acceptance_ids.some(
        (id) => !task.acceptance_criteria.some((item) => item.id === id),
      )
    )
      throw new AppError(
        "BUSINESS_DELTA_ACCEPTANCE",
        "草案引用了任务中不存在的验收项",
      );
    if (
      raw.acceptance_ids.some(
        (id) =>
          task.acceptance_criteria.find((item) => item.id === id)?.status !==
          "pending",
      )
    )
      throw new AppError(
        "BUSINESS_DELTA_ACCEPTANCE",
        "保存新草案前须将关联验收重开为 pending，绑定草案场景后重新核验",
      );
    const newModel = raw.base_revision === 0;
    const selection = knowledge.modules?.find(item => item.model_id === raw.model_id);
    if (!newModel && (selection?.state !== "matched" || !snapshotIds.has(raw.model_id)))
      throw new AppError("PROJECT_MODEL_REVIEW_REQUIRED", "草案使用的模型在当前工作树尚无唯一适用版本，请先核对候选");
    if (newModel && all.some(model => model.id === raw.model_id))
      throw new AppError("BUSINESS_DELTA_CONFLICT", "新业务模型 ID 已存在，请读取后按已有模型建立草案");
    const model = newModel ? undefined : requireModel(all, raw.model_id);
    assertEnhancedModelWrites(model?.schema_version === 3);
    const before = model?.rules.find((rule) => rule.id === raw.rule_id) ?? null;
    if (
      (model?.revision ?? 0) !== raw.base_revision ||
      (raw.operation === "add"
        ? !!before
        : !before || ruleFingerprint(before) !== raw.expected_rule_fingerprint)
    )
      throw new AppError(
        "BUSINESS_DELTA_CONFLICT",
        "草案基准修订或规则指纹不一致，请重新读取当前模型",
      );
    if (raw.operation === "modify") checkScenarioRetirements(raw.rule_id, before ? [SavedRuleV3.parse(before).semantics].flatMap(item => item ?? []) : [],
      raw.proposed_rule?.semantics, raw.scenario_retirements ?? [], new Set(raw.sources.map(item => item.id)));
    if (raw.proposed_rule?.semantics) {
      const semantics = raw.proposed_rule.semantics;
      const references = [semantics, ...semantics.cases, ...semantics.preserves, ...(raw.proposed_rule.bindings ?? [])];
      if (references.some(item => item.source_ids.some(id => !raw.proposed_rule!.source_ids.includes(id)))
        || semantics.cases.some(item => evaluateRule(semantics.when, item.facts) !== item.expected))
        throw new AppError("BUSINESS_DELTA_SEMANTICS", "草案的条件、场景和代码位置须引用本规则来源，场景期望须与结构化条件一致");
      for (const items of [semantics.cases, semantics.preserves, raw.proposed_rule.bindings ?? []]) {
        if (new Set(items.map(item => item.id)).size !== items.length) throw new AppError("BUSINESS_DELTA_SEMANTICS", "场景、保留行为和绑定 ID 不能重复");
      }
    }
    if (raw.supersedes_id) {
      const replaced = history.find(
        (record) => record.input.id === raw.supersedes_id,
      );
      if (
        !replaced ||
        replaced.input.model_id !== raw.model_id ||
        replaced.input.rule_id !== raw.rule_id ||
        history.some(
          (record) => record.input.supersedes_id === raw.supersedes_id,
        )
      )
        throw new AppError(
          "BUSINESS_DELTA_SUPERSEDES",
          "只能追加修订同一目标且尚未被替代的草案",
        );
      const saved = await optional(files, receiptPath(task, replaced));
      if (saved) {
        const journal = JournalSchema.parse(JSON.parse(saved)),
          receipt = journal.receipt;
        if (!receipt || journal.pending)
          throw new AppError(
            "BUSINESS_DELTA_APPLY_PENDING",
            "原草案仍有未完成发布，先恢复该次发布后再追加业务修订",
          );
        if (
          receipt.published_rule_fingerprint !==
          (before ? ruleFingerprint(before) : null)
        )
          throw new AppError(
            "BUSINESS_DELTA_CONFLICT",
            "当前规则已偏离原发布结果，请先核对业务变更链，不能覆盖后续修改",
          );
      }
    } else if (
      activeDeltas({ ...task, business_deltas: history }).some(
        (record) =>
          record.input.model_id === raw.model_id &&
          record.input.rule_id === raw.rule_id,
      )
    ) {
      throw new AppError(
        "BUSINESS_DELTA_DUPLICATE",
        "同一目标已有草案，修订时请明确 supersedes_id",
      );
    }
    if (newModel && activeDeltas({ ...task, business_deltas: history }).some(other => other.input.model_id === raw.model_id && other.input.id !== raw.supersedes_id))
      throw new AppError("BUSINESS_DELTA_CONFLICT", "新模型先用一条业务规则建立首版，验证发布后再追加其它规则");
    const sources = [];
    for (const source of raw.sources)
      sources.push(await evidence.validate(source));
    const input = { ...raw, sources };
    const base_snapshot_id = snapshotIds.get(raw.model_id);
    const record = {
      input,
      before_rule: before,
      ...(base_snapshot_id ? { base_snapshot_id } : {}),
      fingerprint: fingerprint(input, before, base_snapshot_id),
      recorded_at: new Date().toISOString(),
    };
    if (raw.acceptance_ids.length < businessDeltaScenarios(record).length)
      throw new AppError(
        "BUSINESS_DELTA_SCENARIO",
        "关联验收数量不足以覆盖本次业务变更的正常、边界及例外场景，请拆分验收",
      );
    history.push(record);
  }
  const latest = await readProjectKnowledge(binding);
  if (
    latest.view_token !== knowledge.view_token || latest.transaction_id !== knowledge.transaction_id || latest.state !== knowledge.state
  )
    throw new AppError(
      "BUSINESS_DELTA_CONFLICT",
      "记录草案期间模型已变化，请重新核对",
    );
  if (history.length > 20)
    throw new AppError(
      "BUSINESS_DELTA_LIMIT",
      "本任务业务草案超过 20 条，请缩小任务范围",
    );
  return history;
}

/** 服务端回执和现行规则共同核验；自报完成、过期快照或规则再次变更均不算已应用。 */
export async function businessDeltaReview(
  binding: WorktreeBinding,
  task: BusinessDeltaTask,
  snapshot: string,
) {
  assertBinding(binding, task);
  const active = activeDeltas(task);
  if (!active.length)
    return {
      state: "checked" as const,
      items: [],
      limitation: "本任务没有业务变更草案。",
    };
  const files = new ProjectFiles(binding.root);
  const loaded = await loadWorktreeModels(binding, files);
  // 回执复核需要看到当前工作树的本地候选，才能把“代码已变化”识别为
  // stale。候选只用于比较与给出修订提示，仍不会进入普通生成上下文。
  const all = [...loaded.models, ...loaded.reviewCandidates];
  const items = [], evidence = await evidenceFor(files, binding, task);
  for (const record of active) {
    const raw = await optional(files, receiptPath(task, record)),
      journal = raw ? JournalSchema.parse(JSON.parse(raw)) : undefined;
    const receipt = journal?.receipt,
      model = all.find((item) => item.id === record.input.model_id);
    const rule =
      model && model.schema_version !== 1
        ? model.rules.find((item) => item.id === record.input.rule_id)
        : undefined;
    let state: "pending" | "conflict" | "stale" | "applied" = "pending";
    if (receipt) {
      const sameRule =
        receipt.published_rule_fingerprint ===
        (rule ? ruleFingerprint(rule) : null);
      state =
        receipt.task_id !== task.id ||
        receipt.delta_id !== record.input.id ||
        receipt.model_id !== record.input.model_id ||
        receipt.rule_id !== record.input.rule_id ||
        receipt.operation !== record.input.operation ||
        receipt.delta_fingerprint !== record.fingerprint ||
        !sameRule ||
        !model
          ? "conflict"
          : receipt.review_snapshot !== snapshot
          ? "stale"
          : "applied";
      if (state === "applied" && rule && model && model.schema_version !== 1) {
        for (const version of rule.evidence_versions) {
          const source = model.sources.find((item) => item.id === version.id);
          if (
            !source ||
            sourceFingerprint(source) !== version.fingerprint ||
            (await evidence.sourceState(source)) !== "current"
          ) {
            state = "stale";
            break;
          }
        }
      }
      if (state === "applied") {
        for (const source of record.input.sources)
          if ((await evidence.sourceState(source)) !== "current") {
            state = "stale";
            break;
          }
        try {
          assertAcceptance(task, record, snapshot);
        } catch {
          state = "stale";
        }
      }
    } else if (
      model?.schema_version === 1 ||
      (record.input.operation === "add"
        ? !!rule
        : !same(rule, record.before_rule))
    )
      state = "conflict";
    items.push({
      id: record.input.id,
      model_id: record.input.model_id,
      rule_id: record.input.rule_id,
      operation: record.input.operation,
      before_rule: record.before_rule,
      proposed_rule: record.input.proposed_rule ?? null,
      acceptance_ids: record.input.acceptance_ids,
      scenarios: businessDeltaScenarios(record),
      state,
      ...(receipt ? { receipt } : {}),
      ...(journal?.pending ? { recovery_pending: true } : {}),
      receipt_count: journal?.receipt_history.length ?? 0,
    });
  }
  return {
    state: items.every((item) => item.state === "applied")
      ? ("checked" as const)
      : ("pending" as const),
    items,
    limitation:
      "草案是待验收的需求预期；应用回执证明模型发布与代码快照关联，不证明业务语义正确。",
  };
}
export function assertBusinessDeltas(
  review: Awaited<ReturnType<typeof businessDeltaReview>>,
): void {
  if (review.state !== "checked")
    throw new AppError(
      "BUSINESS_DELTA_PENDING",
      "先完成业务变更验收和模型回写，处理冲突或过期回执后再关闭任务",
    );
}

/** 只在发布中断时查找不可变模型修订；先用checkpoint，缺失时有界扫描marker，不凭语义相似认领发布。 */
async function recoverPublication(
  files: ProjectFiles,
  model: ModernModel,
  pending: z.infer<typeof AttemptSchema>,
): Promise<ModernModel | undefined> {
  const accept = (candidate: SavedModel) =>
    candidate.schema_version !== 1 &&
    candidate.id === model.id &&
    candidate.project === files.root &&
    candidate.revision === pending.expected_revision &&
    (candidate.revision_reason === pending.marker ||
      pending.revalidation_only === true);
  if (pending.published_hash) {
    const raw = await files.read(
      `${MAP_DIR}/models/${pending.published_hash}.json`,
      65_536,
    );
    if (digest(raw) !== pending.published_hash)
      throw new AppError(
        "BUSINESS_DELTA_RECOVERY_CORRUPT",
        "业务发布checkpoint与模型内容不一致",
      );
    const candidate = SavedModelSchema.parse(JSON.parse(raw));
    if (!accept(candidate))
      throw new AppError(
        "BUSINESS_DELTA_RECOVERY_CORRUPT",
        "业务发布checkpoint的模型身份不一致",
      );
    return candidate as ModernModel;
  }
  if (accept(model)) return model;
  if (model.revision < pending.expected_revision) return undefined;
  const names = await readdir(await files.path(`${MAP_DIR}/models`));
  if (names.length > 2_000)
    throw new AppError(
      "BUSINESS_DELTA_RECOVERY_LIMIT",
      "模型历史超过中断恢复扫描上限，请核对发布checkpoint，不能盲目重放",
    );
  let found: ModernModel | undefined;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const raw = await files.read(`${MAP_DIR}/models/${name}`, 65_536);
    if (digest(raw) !== name.slice(0, -5))
      throw new AppError(
        "BUSINESS_DELTA_RECOVERY_CORRUPT",
        "模型历史内容哈希不一致",
      );
    const candidate = SavedModelSchema.parse(JSON.parse(raw));
    if (!accept(candidate)) continue;
    if (found)
      throw new AppError(
        "BUSINESS_DELTA_RECOVERY_CONFLICT",
        "同一发布标记对应多个模型修订，请先核对历史",
      );
    found = candidate as ModernModel;
  }
  return found;
}

/** 在理解目录锁中发布；新快照必须实际重核，复核追加回执，不改写原发布历史。 */
export async function applyBusinessDelta(
  binding: WorktreeBinding,
  task: BusinessDeltaTask,
  value: unknown,
): Promise<BusinessDeltaReceipt> {
  assertBinding(binding, task);
  await assertBaseline(binding, task as Task);
  await assertStateIgnored(binding);
  const input = BusinessDeltaApplyInputSchema.parse(value),
    record = activeDeltas(task).find(
      (item) => item.input.id === input.delta_id,
    );
  if (
    !record ||
    record.fingerprint !== fingerprint(record.input, record.before_rule, record.base_snapshot_id)
  )
    throw new AppError(
      "BUSINESS_DELTA_UNKNOWN",
      "未找到有效草案或草案内容不一致",
    );
  const snapshot = await reviewSnapshot(
    binding,
    task.baseline_head,
    task.workspace_baseline,
  );
  assertAcceptance(task, record, snapshot.hash);
  const files = new ProjectFiles(binding.root);
  const apply = async () => {
    const path = receiptPath(task, record);
    const raw = await optional(files, path), journal = raw ? JournalSchema.parse(JSON.parse(raw)) : JournalSchema.parse({});
    const { knowledge, config, models: visible, reviewCandidates } = await loadWorktreeModels(binding, files,
      new Set([`${record.input.model_id}/${record.input.rule_id}`]));
    if (knowledge.state === "unavailable") throw new AppError("PROJECT_KNOWLEDGE_UNAVAILABLE", "共享业务模型暂无法核验，请重新查询当前项目");
    const selection = knowledge.modules?.find(item => item.model_id === record.input.model_id);
    if (!record.input.new_model && (!selection || selection.state === "ambiguous" || selection.state === "partial"))
      throw new AppError("PROJECT_MODEL_REVIEW_REQUIRED", "本次规则回写涉及未解决的模型候选，请先复核");
    if (knowledge.rule_reviews?.items.some(item => item.model_id === record.input.model_id && item.rule_id === record.input.rule_id
      && ["configuration", "evidence_revision"].includes(item.kind)))
      throw new AppError("PROJECT_MODEL_REVIEW_REQUIRED", "本次规则回写涉及待复核的来源或绑定，请先处理模型证据");
    const local = (await models(files)).find(item => item.id === record.input.model_id);
    const chosen = visible.find(item => item.id === record.input.model_id);
    // Codex 修改代码后，原规则自然不再匹配。用任务开工时保存的只读快照恢复实际前镜像。
    const pinned = !chosen && record.base_snapshot_id
      ? await readModelSnapshot(binding, record.input.model_id, record.base_snapshot_id) : undefined;
    const pinnedModel = pinned ? worktreeModel(binding.root, pinned.content, record.input.model_id) : undefined;
    // 业务回写是在当前工作树已改代码之后执行的。此时本地旧模型仍是
    // “待复核候选”，但它可能包含同一任务之外已经保存的摘要或规则修订，
    // 不能退回开工快照把这些合法修订覆盖掉。只有显式业务回写路径才
    // 使用候选作为合并基线，普通生成链路仍只接收 visible。
    const candidate = reviewCandidates.find(item => item.id === record.input.model_id);
    const existing = journal.pending && local ? local : chosen ?? candidate ?? pinnedModel;
    const all = [...visible.filter(item => item.id !== record.input.model_id), ...(existing && modelVisible(existing, config) ? [existing] : [])];
    const initialModel = record.input.new_model;
    const model = existing || !initialModel ? requireModel(all, record.input.model_id) : undefined;
    assertEnhancedModelWrites(model?.schema_version === 3 || enhancedBusinessDelta(record.input));
    const inputHash = digest(JSON.stringify(input));
    const marker = `business-delta:${digest(
      JSON.stringify([task.id, record.fingerprint, snapshot.hash, inputHash]),
    )}`;
    const currentRule = model?.rules.find(
        (rule) => rule.id === record.input.rule_id,
      ),
      removing = record.input.operation === "remove";
    const evidence = await evidenceFor(files, binding, task);
    for (const source of record.input.sources)
      if ((await evidence.sourceState(source)) !== "current")
        throw new AppError(
          "BUSINESS_DELTA_SOURCE_STALE",
          "草案需求来源已变化，请先追加修订草案并重新核验预期",
        );
    const makeReceipt = (published: ModernModel, token: string) =>
      BusinessDeltaReceiptSchema.parse({
        task_id: task.id,
        delta_id: record.input.id,
        delta_fingerprint: record.fingerprint,
        model_id: published.id,
        model_revision: published.revision,
        rule_id: record.input.rule_id,
        operation: record.input.operation,
        published_rule_fingerprint: published.rules.find(
          (rule) => rule.id === record.input.rule_id,
        )
          ? ruleFingerprint(
              published.rules.find((rule) => rule.id === record.input.rule_id)!,
            )
          : null,
        review_snapshot: token,
        applied_at: new Date().toISOString(),
      });
    const publishSharedApply = async (published: ModernModel, reviewToken = snapshot.hash) => {
      // 共享快照和应用回执必须使用同一 operation_id；失败时保留本地 pending，
      // 下一次调用会先恢复并重试这一事务，不能把本地模型当成已同步。
      return publishModelShadow(binding, published as unknown as Record<string, unknown>, {
        receipt: {
          operation_id: marker,
          task_id: task.id,
          delta_id: record.input.id,
          delta_fingerprint: record.fingerprint,
          review_snapshot: reviewToken,
        },
        ...(model && model.revision < published.revision ? { base_model: model as unknown as Record<string, unknown> } : {}),
      });
    };
    const preserveReceipt = (receipt: BusinessDeltaReceipt) => {
      if (journal.receipt_history.length >= 40)
        throw new AppError(
          "BUSINESS_DELTA_LIMIT",
          "本草案复核回执达到40次，请结束或中止任务后缩小范围",
        );
      journal.receipt_history.push(receipt);
      journal.receipt = receipt;
      delete journal.pending;
    };
    // 模型已发布而回执尚未保存：marker证明该次发布；先保留原快照回执，再处理新的代码复核。
    if (journal.pending && model) {
      if (journal.pending.review_snapshot !== snapshot.hash)
        throw new AppError(
          "BUSINESS_DELTA_RECOVERY_STALE",
          "上次业务模型发布中断后工作树已变化；先恢复原代码快照或重新核对该草案，不能把旧发布绑定到新代码",
        );
      const recovered = await recoverPublication(files, model, journal.pending);
      if (recovered) {
        const recoveredRule = recovered.rules.find(
          (rule) => rule.id === record.input.rule_id,
        );
        if (
          (recoveredRule ? ruleFingerprint(recoveredRule) : null) !==
          (currentRule ? ruleFingerprint(currentRule) : null)
        )
          throw new AppError(
            "BUSINESS_DELTA_CONFLICT",
            "中断后的目标规则已被其他变更修改，请先核对业务链，不能认领旧发布为当前结果",
          );
        await publishSharedApply(recovered, journal.pending.review_snapshot);
        preserveReceipt(
          makeReceipt(recovered, journal.pending.review_snapshot),
        );
        await save(files, path, journal);
      }
    }
    const prior = journal.receipt;
    if (
      prior &&
      prior.published_rule_fingerprint !==
        (currentRule ? ruleFingerprint(currentRule) : null)
    )
      throw new AppError(
        "BUSINESS_DELTA_CONFLICT",
        "当前规则不同于原发布规则，请建立新的业务变更，不能只刷新回执",
      );
    if (prior?.review_snapshot === snapshot.hash) return prior;
    if (!prior && initialModel && model) throw new AppError("BUSINESS_DELTA_CONFLICT", "验证期间已建立同 ID 模型，不能覆盖，请读取当前版本并更新草案");
    if (!prior && model) assertUnchanged(model, record);
    if (
      journal.pending &&
      (journal.pending.input_hash !== inputHash ||
        journal.pending.review_snapshot !== snapshot.hash)
    ) {
      // 未发布的准备记录可以放弃，但保留轨迹；已发布却失去marker不能当作未执行重放。
      if (journal.abandoned_attempts.length >= 40)
        throw new AppError(
          "BUSINESS_DELTA_LIMIT",
          "未完成发布记录过多，请核对当前模型后缩小任务",
        );
      journal.abandoned_attempts.push(journal.pending);
      delete journal.pending;
    }
    if (
      removing
        ? !!input.observed_rule
        : !input.observed_rule ||
          input.observed_rule.basis !== "observed" ||
          input.observed_rule.id !== record.input.rule_id
    )
      throw new AppError(
        "BUSINESS_DELTA_OBSERVED_REQUIRED",
        "新增或修改须独立提交有当前代码来源的 observed 规则；删除不提交 observed_rule",
      );
    const semantics = (rule: NonNullable<typeof input.observed_rule>) => [
      rule.id,
      rule.description,
      rule.responsibility,
      rule.conditions,
      rule.exceptions,
      rule.assertion ?? null,
      rule.semantics ? {
        subject: rule.semantics.subject, action: rule.semantics.action, when: rule.semantics.when, expected: rule.semantics.expected,
        preserves: rule.semantics.preserves.map(({ source_ids, ...item }) => item),
        cases: rule.semantics.cases.map(({ source_ids, ...item }) => item),
      } : null,
    ];
    if (
      input.observed_rule &&
      !same(
        semantics(input.observed_rule),
        semantics(record.input.proposed_rule!),
      )
    )
      throw new AppError(
        "BUSINESS_DELTA_INTENT_MISMATCH",
        "实际规则与草案预期不同，请先修订草案及关联验收，不能直接发布分歧行为",
      );
    if (
      !input.sources.some((source) => source.kind === "code") ||
      input.observed_rule?.source_ids.some(
        (id) => !input.sources.some((source) => source.id === id),
      )
    )
      throw new AppError(
        "BUSINESS_DELTA_OBSERVED_REQUIRED",
        "回写须引用本次实际核对的代码来源",
      );
    for (const source of input.sources) await evidence.validate(source);
    if (input.observed_rule?.semantics) {
      const observed = input.observed_rule;
      const expected = [...(record.before_rule && "bindings" in record.before_rule ? record.before_rule.bindings ?? [] : []),
        ...(record.input.proposed_rule?.bindings ?? [])];
      const { config } = await loadConfig(files);
      const resolver = new CodeBindingResolver(files, config);
      if (!observed.bindings?.length || expected.some(bound => !observed.bindings?.some(current => current.id === bound.id
        && current.path === bound.path && current.symbol === bound.symbol && current.role === bound.role)))
        throw new AppError("BUSINESS_DELTA_BINDINGS", "回写须保留已核对的代码位置，并解析草案中的新增位置");
      for (const bound of observed.bindings) {
        if (bound.planned || (await resolver.resolve(bound)).resolution !== "resolved")
          throw new AppError("BUSINESS_DELTA_BINDINGS", "业务模型回写需要当前代码中真实且唯一的符号");
      }
    }
    if (removing && !prior && model?.rules.length === 1)
      throw new AppError(
        "BUSINESS_DELTA_LAST_RULE",
        "不能通过规则草案删除模型最后一条规则，请另行明确模型退役范围",
      );
    if (
      removing &&
      model?.relations.some((relation) =>
        relation.rule_ids.includes(record.input.rule_id),
      )
    )
      throw new AppError(
        "BUSINESS_DELTA_RELATIONS",
        "该规则仍被业务关系引用，请先明确修订关联关系，不能隐式删除",
      );
    // 不重写其他规则共用的来源，避免局部回写改变其解释或偷偷刷新依据。
    // 退役的规格依据随新修订保留，不能把代码观察冒充需求废止决定。
    const retirements = prior ? [] : record.input.scenario_retirements ?? [];
    const retirementIds = new Set(retirements.map(item => item.source_id));
    const modelSources = [...input.sources];
    for (const source of record.input.sources.filter(item => retirementIds.has(item.id))) {
      const existingSource = modelSources.find(item => item.id === source.id);
      if (existingSource && !same(existingSource, source))
        throw new AppError("BUSINESS_DELTA_SOURCE_SHARED", "退役依据和实现依据的 ID 冲突，请使用独立 ID");
      if (!existingSource) modelSources.push(source);
    }
    for (const source of modelSources) {
      const previous = model?.sources.find((item) => item.id === source.id);
      if (
        previous &&
        !same(previous, source) &&
        (model?.rules.some(
          (rule) =>
            rule.id !== record.input.rule_id &&
            rule.source_ids.includes(source.id),
        ) ||
          model?.relations.some((relation) =>
            relation.source_ids.includes(source.id),
          ))
      )
        throw new AppError(
          "BUSINESS_DELTA_SOURCE_SHARED",
          "来源 ID 被其他规则或关系使用，请为新依据使用独立 ID",
        );
    }
    const map = await readMap(files);
    if (!map)
      throw new AppError("PROJECT_MAP_CHANGED", "业务回写前需要当前项目扫描");
    if (
      (
        await reviewSnapshot(
          binding,
          task.baseline_head,
          task.workspace_baseline,
        )
      ).hash !== snapshot.hash
    )
      throw new AppError(
        "REVIEW_SNAPSHOT_CHANGED",
        "回写前代码变化，请重新核验业务验收",
      );
    journal.pending = {
      input_hash: inputHash,
      marker,
      review_snapshot: snapshot.hash,
      expected_revision:
        removing && prior && model ? model.revision : (model?.revision ?? 0) + 1,
      ...(removing && prior ? { revalidation_only: true } : {}),
    };
    await save(files, path, journal);
    // 删除后的复核只重新核对停用证据；不再次删除规则，也不扩大到模型退役。
    const sourcePaths = modelSources.flatMap(source => sourcePath(source) ? [sourcePath(source)!] : []);
    const published = removing && prior && model ? model : ((await recordModel(files, binding, {
            id: record.input.model_id,
            schema_version: initialModel || input.observed_rule?.semantics || input.observed_rule?.bindings?.length ? 3 : model?.schema_version ?? 2,
            scan_id: map.scan_id,
            expected_revision: model?.revision ?? 0,
            revision_reason: marker,
            ...(!model && initialModel ? { ...initialModel, related_paths: [...new Set(sourcePaths)], sources: input.sources,
              rules: [input.observed_rule!], relations: [] } : { patch: removing
              ? { remove_rule_ids: [record.input.rule_id] }
              : {
                  metadata: {
                    related_paths: [
                      ...new Set([
                        ...(model?.related_paths ?? []),
                        ...sourcePaths,
                      ]),
                    ],
                  },
                  upsert_sources: modelSources,
                  ...(retirements.length ? { scenario_retirements: retirements } : {}),
                  upsert_rules: [input.observed_rule!],
                } }),
          }, all)) as ModernModel);
    const publishedIndex = (await modelIndex(files)).find(
      (item) =>
        item.id === published.id && item.revision === published.revision,
    );
    if (!publishedIndex)
      throw new AppError(
        "BUSINESS_DELTA_RECOVERY_CORRUPT",
        "已发布模型缺少对应索引，保留准备阶段以便恢复",
      );
    journal.pending.published_hash = publishedIndex.hash;
    await save(files, path, journal);
    await publishSharedApply(published);
    const receipt = makeReceipt(published, snapshot.hash);
    preserveReceipt(receipt);
    await save(files, path, journal);
    if (
      (
        await reviewSnapshot(
          binding,
          task.baseline_head,
          task.workspace_baseline,
        )
      ).hash !== snapshot.hash
    )
      throw new AppError(
        "REVIEW_SNAPSHOT_CHANGED",
        "发布期间代码变化，原快照回执已保留；请在当前代码上重新核验后追加复核回执",
      );
    return receipt;
  };
  return locked(files, apply);
}
