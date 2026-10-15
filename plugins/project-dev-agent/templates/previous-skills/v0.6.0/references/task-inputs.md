# Task tool inputs

The server exposes `project_prepare`, `task_open`, `task_update`, `task_check`, `knowledge_search` and `experience_propose`. Tool descriptions advertise their schemas. Examples are shapes to adapt to the actual project, not a checklist of business requirements.

Workspace mode requires `"project": "/absolute/current/repository"` on **every** example below. First inspect readiness with `{ "project": "/absolute/current/repository" }` passed to `project_prepare`; add `"apply": true` to prepare local ignores. Readiness includes `state_ignored`, `worktree_clean`, `ready_to_open` and `active_task`. Preparing a dirty worktree preserves its changes and does not make it ready to open.

To recover after a new chat or process restart, call `task_check` with just `project`. It returns the full unique active task, or `NO_ACTIVE_TASK`. Always use the recovered revision for updates. An explicit ID reads historical closed/aborted tasks too. Keep the same project for every call belonging to that task.

```json
{
  "requirement": "Implement the user request",
  "acceptance_criteria": [
    { "id": "behavior", "description": "Describe the observable result" }
  ]
}
```

After opening, use the returned `id` and `revision`:

```json
{
  "task_id": "returned-task-id",
  "expected_revision": 0,
  "change_items": [
    {
      "id": "entry-point",
      "target_path": "src/entry.js",
      "action": "modify",
      "requirement": "Adapt this entry point",
      "rationale": "Explain why it is affected",
      "sources": [{ "kind": "code", "reference": "src/entry.js" }],
      "status": "pending"
    }
  ]
}
```

Source kinds: `code/document/experience`. Sources need a reference; an optional description explains it. A checked item adds `reviewed_by` and nonempty `evidence` with `kind: code/test/manual`, `reference` and `summary`. A skipped item adds `reviewed_by` and `skip_reason`.

Acceptance records use `id`, `description`, `status: pending/checked`, `reviewed_by` and `evidence`. Validation records use `id`, `description`, `outcome: passed/failed/not_run` and `evidence`; executed validation needs evidence. Correction records use `id`, `description`, `rationale` and `sources`.

Update only the collections that changed, supplying their full contents and retaining existing IDs. Latest records can be obtained through `task_check`; `pending_acceptance` and `pending_items` are unresolved IDs. Each successful update returns a new revision. Record comparisons are optimistic; a busy store or version conflict requires reading the latest state before deciding whether to retry.

Before finishing, call `task_check` with `{ "task_id": "returned-task-id" }`. `structurally_reviewed` concerns recorded decisions and file coverage; it does not independently validate business logic. The full task appears in `recorded_task`.

For completed work, set `phase: closed` in an update using the latest revision and valid records. For stopped work, set `phase: aborted` and `abort_reason`. Ended tasks are read-only historical records; create another task from a clean baseline for later changes.

## Knowledge and corrections

Search shape: `{ "query": "task keywords", "paths": ["src/entry.js"], "modules": ["module-name"], "limit": 5 }`. Omit unknown module names. Scope filters are conjunctive when provided. Results include ID, file, content hash `version`, sources, `effective` and applicable conditions. `include_unconfirmed: true` includes review hints; they remain ineffective. Partial results carry diagnostics and must not be treated as a complete knowledge scan.

Save used confirmed knowledge with `task_update` using `knowledge_versions: [{ "id": "rule-id", "version": "returned-sha256" }]` before changing source files. Keep previous IDs. Task records retain these as historical versions; current search may request review after source files change.

Propose shape: `{ "task_id": "...", "correction_id": "existing-correction-id", "title": "Reusable lesson", "type": "change_relation", "modules": ["module-name"], "paths": ["src"], "applicable_conditions": ["Specific situation"], "rule": "Proposed behavior", "review_questions": ["What must a colleague verify?"] }`. Types also include `code_convention` and `business_rule`. The tool copies the correction's rationale and sources; it writes only a local draft and returns its relative path. It cannot confirm or publish a rule.
