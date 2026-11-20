import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError } from "../domain/error.js";
import { IdSchema, RelativePathSchema, ReviewSnapshotSchema } from "../domain/common.js";
import { TaskSchema } from "../domain/task.js";
import { RequirementSourceRecord } from "../quality/requirement-contracts.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { acquireFileLock } from "../storage/file-lock.js";

type RequirementSourceRecord = z.infer<typeof RequirementSourceRecord>;

/** 同一需求的实现切片；full 适用于没有拆分的普通任务。 */
export const RequirementTaskKind = z.enum(["full", "ui", "api", "test", "integration", "review"]);
export type RequirementTaskKind = z.infer<typeof RequirementTaskKind>;

const TaskPhase = z.enum(["active", "suspended", "closed", "aborted"]);
const Scope = z.object({
  task_id: IdSchema,
  worktree_path: z.string().min(1).max(4_096),
  branch: z.string().max(1_000).nullable(),
  requirement_role: RequirementTaskKind,
  scope_paths: z.array(RelativePathSchema).max(30),
  phase: TaskPhase,
  relationship: z.enum(["new_requirement", "same_requirement_child", "continuation"]),
  updated_at: z.string().datetime({ offset: true }),
}).strict();
type ScopeEntry = z.infer<typeof Scope>;

export const RequirementGroup = z.object({
  schema_version: z.literal(1),
  id: IdSchema,
  repository_key: ReviewSnapshotSchema,
  requirement_fingerprint: ReviewSnapshotSchema,
  source_fingerprints: z.array(ReviewSnapshotSchema).max(100),
  acceptance_fingerprint: ReviewSnapshotSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  status: z.enum(["active", "integrated", "aborted"]),
  tasks: z.array(Scope).max(100),
}).strict();
export type RequirementGroup = z.infer<typeof RequirementGroup>;

const Registry = z.object({ schema_version: z.literal(1), repository_key: ReviewSnapshotSchema,
  groups: z.array(RequirementGroup).max(200) }).strict();
type Registry = z.infer<typeof Registry>;

export type RequirementGroupResolution = {
  group_id: string;
  requirement_fingerprint: string;
  relationship: "new_requirement" | "same_requirement_child" | "continuation";
  link: "explicit" | "auto_source_match" | "new";
  scope_state: "standalone" | "parallel_allowed" | "scope_overlap_review";
  related_task_ids: string[];
};

/**
 * 需求组登记后的实际并发状态；该结果只供任务服务内部使用，MCP 协议不暴露新字段。
 * 登记必须在同一把公共索引锁内重算，避免两个工作树同时解析到旧快照而漏掉范围冲突。
 */
export type RequirementGroupRegistration = {
  group: RequirementGroup;
  scope_state: RequirementGroupResolution["scope_state"];
  related_task_ids: string[];
};

export type RequirementGroupReconcileResult = {
  archived_task_ids: string[];
  synchronized_task_ids: string[];
  unreadable_task_ids: string[];
};

/**
 * 同一仓库的需求组保存到 Git 公共目录。任务记录由各自的工作树独立维护。
 */
export class RequirementGroupStore {
  private readonly commonDir: string;
  private readonly repositoryKey: string;
  private readonly base: string;

  constructor(repository: string) {
    this.commonDir = repository;
    this.repositoryKey = createHash("sha256").update(repository).digest("hex");
    this.base = `project-dev-agent/requirement-groups/${this.repositoryKey}`;
  }

  /** 使用 Git 已核验的公共目录，文件操作继续检查符号链接和实际路径。 */
  private async files() { return new ProjectFiles(await realpath(this.commonDir)); }
  private registryPath() { return `${this.base}/registry.json`; }

  /** 不同工作树同时建组或登记时短暂排队，读到最新索引再追加。 */
  private async lock(files: ProjectFiles) {
    await files.directory(this.base);
    for (let attempt = 0; ; attempt++) {
      try { return await acquireFileLock(files, `${this.base}/registry.lock`, "REQUIREMENT_GROUP_BUSY"); }
      catch (error) {
        if (!hasCode(error, "REQUIREMENT_GROUP_BUSY") || attempt === 40) throw error;
        await delay(20);
      }
    }
  }

  private async read(): Promise<{ files: ProjectFiles; raw?: string; registry: Registry }> {
    const files = await this.files();
    try {
      const raw = await files.read(this.registryPath(), 1_000_000);
      const registry = Registry.parse(JSON.parse(raw));
      if (registry.repository_key !== this.repositoryKey) throw new AppError("REQUIREMENT_GROUP_REPOSITORY_MISMATCH", "需求组登记不属于当前仓库");
      return { files, raw, registry };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      return { files, registry: { schema_version: 1, repository_key: this.repositoryKey, groups: [] } };
    }
  }

  private async write(files: ProjectFiles, raw: string | undefined, registry: Registry) {
    const text = JSON.stringify(Registry.parse(registry)) + "\n";
    if (raw === undefined) await files.create(this.registryPath(), text, 1_000_000);
    else await files.replace(this.registryPath(), text, raw);
  }

  private normalize(value: string) { return value.trim().replace(/\s+/g, " "); }
  private fingerprint(requirement: string, sources: RequirementSourceRecord[], acceptance: { id: string; description: string }[]) {
    const sourceFingerprints = [...new Set(sources.filter(source => source.input.kind === "document")
      .map(source => source.fingerprint))].sort();
    return { requirement: createHash("sha256").update(this.normalize(requirement)).digest("hex"), sourceFingerprints,
      acceptance: createHash("sha256").update(JSON.stringify(acceptance.map(item => [item.id, this.normalize(item.description)]).sort(([left], [right]) => left!.localeCompare(right!)))).digest("hex") };
  }

  /** 判断目录是否同一范围；父路径覆盖子路径也算重叠，避免只比较字符串相等。 */
  private overlap(left: string[], right: string[]) {
    if (!left.length || !right.length) return true;
    return left.some(a => right.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
  }

  /** 工作树路径由 Git 绑定后应为 canonical path；兼容旧记录时按绝对路径比较。 */
  private sameWorktree(left: string, right: string) {
    return resolvePath(left) === resolvePath(right);
  }

  /**
   * 在 registry 已更新后计算当前任务看到的并发状态。
   * 当前任务本身不参与相关任务计算，避免重复登记把自己误判为冲突。
   */
  private registrationState(group: RequirementGroup, entry: { task_id: string; worktree_path: string; scope_paths: string[] }) {
    const active = group.tasks.filter(task => task.phase === "active" && task.task_id !== entry.task_id);
    const related = active.filter(task => !this.sameWorktree(task.worktree_path, entry.worktree_path) && this.overlap(task.scope_paths, entry.scope_paths));
    return {
      scope_state: !active.length ? "standalone" as const : related.length ? "scope_overlap_review" as const : "parallel_allowed" as const,
      related_task_ids: related.map(task => task.task_id),
    };
  }

  /**
   * 读取工作树中的任务状态，供公共索引对过期条目做保守清理。
   * 缺失记录可以安全归档，损坏或越界记录必须保留并报告，不能静默删除。
   */
  private async localTaskPhase(entry: ScopeEntry): Promise<z.infer<typeof TaskPhase> | "missing" | "unreadable"> {
    try {
      const files = new ProjectFiles(entry.worktree_path);
      const raw = await files.read(`.project-dev/local/tasks/${entry.task_id}.json`, 1_000_000);
      const task = TaskSchema.safeParse(JSON.parse(raw));
      if (!task.success || task.data.id !== entry.task_id
        || task.data.worktree_path !== entry.worktree_path
        || task.data.repo_identity !== this.commonDir) return "unreadable";
      return task.data.phase;
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "PROJECT_PATH_INVALID")) return "missing";
      return "unreadable";
    }
  }

  /**
   * 重新核对公共需求组与各工作树的任务记录。
   *
   * 需求组是跨工作树的索引，工作树可能已被 Git 删除或任务已结束。只归档
   * 已明确不存在的本地记录，已关闭/中止记录同步 phase，无法读取的记录保留
   * 并报告，避免把可恢复的任务误删。调用方可以在 task_open/project_prepare
   * 前执行，确保旧工作树不会长期占用 active 范围。
   */
  async reconcile(): Promise<RequirementGroupReconcileResult> {
    const result: RequirementGroupReconcileResult = { archived_task_ids: [], synchronized_task_ids: [], unreadable_task_ids: [] };
    const files = await this.files();
    const release = await this.lock(files);
    try {
      const current = await this.read();
      let changed = false;
      const groups = [] as RequirementGroup[];
      for (const group of current.registry.groups) {
        let groupChanged = false;
        const tasks: ScopeEntry[] = [];
        for (const entry of group.tasks) {
          // 已经归档的条目不再参与并发判断，避免每次 task_open 都读取整段历史。
          if (entry.phase !== "active") {
            tasks.push(entry);
            continue;
          }
          const phase = await this.localTaskPhase(entry);
          if (phase === "missing") {
            result.archived_task_ids.push(entry.task_id);
            groupChanged = true;
            continue;
          }
          if (phase === "unreadable") {
            result.unreadable_task_ids.push(entry.task_id);
            tasks.push(entry);
            continue;
          }
          if (entry.phase !== phase) {
            result.synchronized_task_ids.push(entry.task_id);
            groupChanged = true;
            tasks.push({ ...entry, phase, updated_at: new Date().toISOString() });
          } else tasks.push(entry);
        }
        if (groupChanged) changed = true;
        groups.push(groupChanged ? { ...group, updated_at: new Date().toISOString(), tasks } : group);
      }
      if (changed) {
        current.registry.groups = groups;
        await this.write(current.files, current.raw, current.registry);
      }
    } finally { await release(); }
    return result;
  }

  /**
   * 检查其它需求组中的活跃范围，只生成提示，不自动合并任务或代码。
   * 同一需求组的关系由 resolve/register 负责，这里只补跨需求的冲突视图。
   */
  async crossScopeOverlaps(input: {
    exclude_group_id?: string;
    worktree_path: string;
    scope_paths: string[];
  }): Promise<{ related_task_ids: string[]; related_group_ids: string[] }> {
    const files = await this.files();
    const release = await this.lock(files);
    try {
      const { registry } = await this.read();
      const related_task_ids: string[] = [];
      const related_group_ids: string[] = [];
      for (const group of registry.groups) {
        if (group.status !== "active" || input.exclude_group_id && group.id === input.exclude_group_id) continue;
        for (const task of group.tasks) {
          if (task.phase !== "active" || this.sameWorktree(task.worktree_path, input.worktree_path)) continue;
          if (!this.overlap(task.scope_paths, input.scope_paths)) continue;
          if (!related_task_ids.includes(task.task_id)) related_task_ids.push(task.task_id);
          if (!related_group_ids.includes(group.id)) related_group_ids.push(group.id);
        }
      }
      return { related_task_ids, related_group_ids };
    } finally { await release(); }
  }

  /** 读取需求组并选择候选；没有唯一证据时创建新组，不把相似文案自动认领为同一需求。 */
  async resolve(input: {
    requirement: string;
    sources: RequirementSourceRecord[];
    acceptance: { id: string; description: string }[];
    requested_group_id?: string;
    parent_task_id?: string;
    continuation_of_task_id?: string;
    worktree_path: string;
    branch: string | null;
    scope_paths: string[];
  }): Promise<RequirementGroupResolution> {
    const { requirement, sources, acceptance, requested_group_id, parent_task_id, continuation_of_task_id } = input;
    const fingerprints = this.fingerprint(requirement, sources, acceptance);
    // 同一个规格可能包含多个需求，只有规格来源、需求原文和验收指纹都相同才允许自动关联。
    const sourceMatch = (item: RequirementGroup) => fingerprints.sourceFingerprints.length > 0
      && item.status === "active" && item.tasks.some(task => task.phase === "active")
      && item.requirement_fingerprint === fingerprints.requirement
      && item.acceptance_fingerprint === fingerprints.acceptance
      && JSON.stringify(item.source_fingerprints) === JSON.stringify(fingerprints.sourceFingerprints);
    const { files, registry } = await this.read();
    let group: RequirementGroup | undefined;
    let link: RequirementGroupResolution["link"] = "new";
    let relationship: RequirementGroupResolution["relationship"] = "new_requirement";
    if (requested_group_id) {
      group = registry.groups.find(item => item.id === requested_group_id);
      if (!group) throw new AppError("REQUIREMENT_GROUP_NOT_FOUND", `需求组 ${requested_group_id} 不存在；先创建主任务或传入已有需求组 ID`);
      if (group.status !== "active") throw new AppError("REQUIREMENT_GROUP_INACTIVE", `需求组 ${requested_group_id} 已处于 ${group.status} 状态，不能继续挂载新任务；请创建新需求组`);
      link = "explicit"; relationship = continuation_of_task_id ? "continuation" : "same_requirement_child";
    } else if (continuation_of_task_id || parent_task_id) {
      const taskId = continuation_of_task_id ?? parent_task_id;
      group = registry.groups.find(item => item.tasks.some(task => task.task_id === taskId));
      if (!group) throw new AppError("REQUIREMENT_PARENT_NOT_FOUND", `找不到关联任务 ${taskId} 的需求组；不能猜测并行关系`);
      if (group.status !== "active") throw new AppError("REQUIREMENT_GROUP_INACTIVE", `任务 ${taskId} 所属需求组已处于 ${group.status} 状态，不能继续挂载新任务`);
      link = "explicit"; relationship = continuation_of_task_id ? "continuation" : "same_requirement_child";
    } else {
      const candidates = registry.groups.filter(sourceMatch);
      if (candidates.length === 1) {
        group = candidates[0]; link = "auto_source_match"; relationship = "same_requirement_child";
      } else if (candidates.length > 1) {
        // 多个需求共用一份规格时不自动选择，避免把 UI/API 任务串到错误版本。
        throw new AppError("REQUIREMENT_GROUP_AMBIGUOUS", "发现多个可能的需求组；请使用 requirement_group_id 明确归属，插件不会按相似文案自动合并");
      }
    }
    if (!group) {
      group = RequirementGroup.parse({ schema_version: 1, id: `rg-${randomUUID()}`, repository_key: this.repositoryKey,
        requirement_fingerprint: fingerprints.requirement, source_fingerprints: fingerprints.sourceFingerprints,
        acceptance_fingerprint: fingerprints.acceptance, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: "active", tasks: [] });
      // 创建组也要走同一把登记锁，避免两个 worktree 同时首次接入时互相覆盖 registry。
      const release = await this.lock(files);
      try {
        const latest = await this.read();
        const candidates = latest.registry.groups.filter(sourceMatch);
        if (candidates.length > 1) throw new AppError("REQUIREMENT_GROUP_AMBIGUOUS", "发现多个可能的需求组；请使用 requirement_group_id 明确归属，插件不会按相似文案自动合并");
        group = candidates[0] ?? group;
        if (candidates[0] && link === "new") { link = "auto_source_match"; relationship = "same_requirement_child"; }
        if (!candidates[0]) {
          latest.registry.groups.push(group);
          await this.write(latest.files, latest.raw, latest.registry);
        }
      } finally { await release(); }
    }
    if (parent_task_id && !group.tasks.some(task => task.task_id === parent_task_id)) throw new AppError("REQUIREMENT_PARENT_NOT_FOUND", `任务 ${parent_task_id} 不属于需求组 ${group.id}`);
    if (continuation_of_task_id && !group.tasks.some(task => task.task_id === continuation_of_task_id)) throw new AppError("REQUIREMENT_PARENT_NOT_FOUND", `任务 ${continuation_of_task_id} 不属于需求组 ${group.id}`);
    const active = group.tasks.filter(task => task.phase === "active");
    const sameWorktree = active.filter(task => task.branch === input.branch && this.sameWorktree(task.worktree_path, input.worktree_path));
    if (sameWorktree.length) throw new AppError("ACTIVE_TASK_EXISTS", `当前工作树已有活跃任务 ${sameWorktree[0]!.task_id}；同一工作树不能并行写入，若是同一需求请切换到独立工作树`);
    const related = active.filter(task => !this.sameWorktree(task.worktree_path, input.worktree_path) && this.overlap(task.scope_paths, input.scope_paths));
    const relatedTaskIds = [...new Set(related.map(task => task.task_id))];
    return { group_id: group.id, requirement_fingerprint: fingerprints.requirement, relationship,
      link, scope_state: !active.length ? "standalone" : related.length ? "scope_overlap_review" : "parallel_allowed",
      related_task_ids: relatedTaskIds };
  }

  /** 任务保存成功后登记工作树和范围；登记是追加式，供其它 worktree 判断同组关系。 */
  async register(entry: {
    group_id: string; task_id: string; worktree_path: string; branch: string | null; requirement_role: RequirementTaskKind;
    scope_paths: string[]; relationship: RequirementGroupResolution["relationship"]; phase?: "active" | "suspended" | "closed" | "aborted";
  }): Promise<RequirementGroupRegistration> {
    const files = await this.files(), release = await this.lock(files);
    try {
      const current = await this.read();
      const group = current.registry.groups.find(item => item.id === entry.group_id);
      if (!group) throw new AppError("REQUIREMENT_GROUP_NOT_FOUND", `需求组 ${entry.group_id} 不存在`);
      if (group.status !== "active" && entry.phase === "active") throw new AppError("REQUIREMENT_GROUP_INACTIVE", `需求组 ${entry.group_id} 已处于 ${group.status} 状态，不能恢复活跃任务`);
      const existing = group.tasks.find(task => task.task_id === entry.task_id);
      if (existing && existing.phase === (entry.phase ?? "active")) {
        return { group, ...this.registrationState(group, entry) };
      }
      if ((entry.phase ?? "active") === "active"
        && group.tasks.some(task => task.task_id !== entry.task_id
          && task.phase === "active" && task.branch === entry.branch
          && this.sameWorktree(task.worktree_path, entry.worktree_path))) {
        throw new AppError("ACTIVE_TASK_EXISTS", "当前工作树已有另一活跃需求；切换分支也不能在同一目录并行写入");
      }
      const next = RequirementGroup.parse({ ...group, updated_at: new Date().toISOString(), tasks: [...group.tasks.filter(task => task.task_id !== entry.task_id), {
        task_id: entry.task_id, worktree_path: entry.worktree_path, branch: entry.branch, requirement_role: entry.requirement_role,
        scope_paths: entry.scope_paths, phase: entry.phase ?? "active", relationship: entry.relationship, updated_at: new Date().toISOString(),
      }] });
      current.registry.groups = current.registry.groups.map(item => item.id === group.id ? next : item);
      await this.write(current.files, current.raw, current.registry);
      return { group: next, ...this.registrationState(next, entry) };
    } finally { await release(); }
  }

  /** 本地任务创建被互斥规则拒绝时清理刚创建的空组，避免空组成为后续自动关联的假证据。 */
  async discardIfEmpty(groupId: string) {
    const files = await this.files(), release = await this.lock(files);
    try {
      const current = await this.read();
      const group = current.registry.groups.find(item => item.id === groupId);
      if (group && group.tasks.length === 0) {
        current.registry.groups = current.registry.groups.filter(item => item.id !== groupId);
        await this.write(current.files, current.raw, current.registry);
      }
    } finally { await release(); }
  }

  async group(id: string) {
    const { registry } = await this.read();
    return registry.groups.find(item => item.id === id);
  }
}
