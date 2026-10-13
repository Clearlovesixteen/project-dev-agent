import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./domain/error.js";
import { TaskSchema } from "./domain/task.js";
import { ToolResultSchema, type ToolResult } from "./domain/result.js";
import { assertBaseline, assertClean, assertStateIgnored, bindWorktree, changedPaths, type WorktreeBinding } from "./git/index.js";
import { TaskStore } from "./storage/task-store.js";
import { TaskCheckInputSchema, TaskOpenInputSchema, TaskUpdateInputSchema } from "./tools/inputs.js";
import { ProjectFiles } from "./storage/project-files.js";
import { loadKnowledge, sourceStates } from "./knowledge/repository.js";

export class TaskService {
  private readonly store: TaskStore;
  constructor(private readonly binding: WorktreeBinding) {
    this.store = new TaskStore(binding.root);
  }

  private async execute(action: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return ToolResultSchema.parse(await action());
    } catch (error: unknown) {
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "OPERATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "error", code, diagnostics: [{ code, message }] };
    }
  }

  async open(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskOpenInputSchema.parse(input);
      const current = await bindWorktree(this.binding.root);
      if (current.repo_identity !== this.binding.repo_identity) throw new AppError("REPOSITORY_CHANGED", "The bound repository identity changed");
      await assertStateIgnored(current);
      await assertClean(current);
      const now = new Date().toISOString();
      const task = TaskSchema.parse({
        schema_version: 1, id: randomUUID(), revision: 0, repo_identity: current.repo_identity, worktree_path: current.root,
        baseline_head: current.head, baseline_branch: current.branch, phase: "active", requirement: request.requirement,
        acceptance_criteria: request.acceptance_criteria, change_items: [], created_at: now, updated_at: now,
      });
      const saved = await this.store.create(task);
      return { outcome: "ok", code: "TASK_OPENED", data: saved, diagnostics: [] };
    });
  }

  async update(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskUpdateInputSchema.parse(input);
      const prior = await this.store.load(request.task_id);
      if (request.phase !== "aborted") await assertBaseline(this.binding, prior);
      if (request.knowledge_versions?.length) {
        const files = new ProjectFiles(this.binding.root);
        const loaded = await loadKnowledge(files);
        for (const version of request.knowledge_versions) {
          // Previously used versions remain historical evidence after source code is edited.
          if (prior.knowledge_versions.some((entry) => entry.id === version.id && entry.version === version.version)) continue;
          const entry = loaded.entries.find((entry) => entry.knowledge.id === version.id && entry.version === version.version);
          if (!entry) throw new AppError("KNOWLEDGE_VERSION_UNKNOWN", `Search again for the current knowledge version: ${version.id}`);
          if (entry.knowledge.status !== "confirmed" || (await sourceStates(files, entry.knowledge)).some((source) => !["current", "attested"].includes(source.state))) {
            throw new AppError("KNOWLEDGE_NEEDS_REVIEW", `Knowledge is not a current confirmed rule: ${version.id}`);
          }
        }
      }
      if (request.phase === "closed") {
        const expected = new Set((request.change_items ?? prior.change_items).map((item) => item.target_path));
        const unexpected = (await changedPaths(this.binding, prior.baseline_head)).filter((path) => !expected.has(path));
        if (unexpected.length > 0) throw new AppError("UNREVIEWED_CHANGES", `Add and review unexpected changes before closing: ${unexpected.join(", ")}`);
      }
      const saved = await this.store.update(request.task_id, request.expected_revision, (current) => {
        const collections = ["change_items", "acceptance_criteria", "validations", "corrections", "knowledge_versions"] as const;
        for (const key of collections) {
          const replacement = request[key];
          if (replacement && current[key].some((entry) => !replacement.some((next) => next.id === entry.id))) {
            throw new AppError("RECORD_REMOVAL_NOT_ALLOWED", `Keep previous ${key} records; revise or resolve them explicitly`);
          }
        }
        return TaskSchema.parse({
          ...current,
          ...(request.change_items !== undefined ? { change_items: request.change_items } : {}),
          ...(request.acceptance_criteria !== undefined ? { acceptance_criteria: request.acceptance_criteria } : {}),
          ...(request.validations !== undefined ? { validations: request.validations } : {}),
          ...(request.corrections !== undefined ? { corrections: request.corrections } : {}),
          ...(request.knowledge_versions !== undefined ? { knowledge_versions: request.knowledge_versions } : {}),
          ...(request.phase !== undefined ? { phase: request.phase } : {}),
          ...(request.abort_reason !== undefined ? { abort_reason: request.abort_reason } : {}),
        });
      });
      return { outcome: "ok", code: "TASK_UPDATED", data: saved, diagnostics: [] };
    });
  }

  async check(input: unknown): Promise<ToolResult> {
    return this.execute(async () => {
      const request = TaskCheckInputSchema.parse(input);
      const task = request.task_id ? await this.store.load(request.task_id) : await this.store.active();
      if (!task) return { outcome: "ok", code: "NO_ACTIVE_TASK", data: { project: this.binding.root, active_task: null }, diagnostics: [] };
      const task_id = task.id;
      if (task.repo_identity !== this.binding.repo_identity) throw new AppError("TASK_BINDING_MISMATCH", "Task belongs to a different repository");
      if (task.phase !== "active") {
        return { outcome: "incomplete", code: "TASK_INACTIVE", data: { task_id, revision: task.revision, phase: task.phase, recorded_task: task },
          diagnostics: [{ code: "TASK_INACTIVE", message: "This task has ended. Its records are historical; current worktree changes are not attributed to it." }] };
      }
      let changed: string[];
      try {
        await assertBaseline(this.binding, task);
        changed = await changedPaths(this.binding, task.baseline_head);
      } catch (error: unknown) {
        const code = error instanceof AppError ? error.code : "BASELINE_UNAVAILABLE";
        return { outcome: "incomplete", code, data: { task_id, revision: task.revision, phase: task.phase, recorded_task: task },
          diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }] };
      }
      const paths = new Set(changed);
      const pending = task.change_items.filter((item) => item.status === "pending").map((item) => item.id);
      const acceptance = task.acceptance_criteria.filter((criterion) => criterion.status !== "checked").map((criterion) => criterion.id);
      const validations = task.validations.filter((record) => record.outcome !== "passed").map((record) => record.id);
      const expected = new Set(task.change_items.map((item) => item.target_path));
      const unexpected = changed.filter((path) => !expected.has(path));
      const reviewed = task.change_items.length > 0 && pending.length === 0 && acceptance.length === 0 && validations.length === 0 && unexpected.length === 0;
      return {
        outcome: reviewed ? "ok" : "incomplete", code: reviewed ? "CHECKLIST_REVIEWED" : "REVIEW_INCOMPLETE",
        data: {
          task_id, revision: task.revision, phase: task.phase, baseline_head: task.baseline_head,
          recorded_task: task,
          changed_paths: changed, unexpected_changes: unexpected, pending_items: pending,
          pending_acceptance: acceptance, unresolved_validations: validations,
          items: task.change_items.map((item) => ({ id: item.id, target_path: item.target_path, status: item.status, changed: paths.has(item.target_path) })),
          structurally_reviewed: reviewed,
          limitation: "Recorded review and file coverage do not independently prove business correctness.",
        },
        diagnostics: reviewed ? [] : [{ code: "REVIEW_INCOMPLETE", message: "Some changes, acceptance criteria, or validation remain unreviewed; inspect the task checklist and diff." }],
      };
    });
  }
}
