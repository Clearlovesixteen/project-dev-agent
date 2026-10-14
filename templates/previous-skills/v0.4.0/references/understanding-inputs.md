# Source-backed project understanding

Workspace tools require `project`, the absolute Git worktree root.

- `project_scan { project }`: prepares a structure snapshot in the ignored local directory. Inspect coverage and diagnostics; no model is invoked. Repeated scans re-hash files but reuse unchanged extraction, then resolve imports against the current inventory.
- `project_context { project, query?, paths?, modules?, limit? }`: returns matching files, hashes, literal direct imports/consumers, module overview and scoped model candidates. `paths` are concrete file/directory prefixes, not globs. Empty input gives an overview; query/paths narrow retrieval. Results may be truncated, so query narrower scopes and inspect relevant source directly. `needs_rescan` means selected sources, configuration or HEAD changed. `unindexed_paths` may indicate newly added or unsupported files. All selected source states must be checked before reuse.

After reading the relevant code and documents, `project_model_record` accepts:

```json
{
  "project": "/absolute/repository",
  "scan_id": "64-character hash returned by the latest scan/context",
  "id": "order-status-flow",
  "expected_revision": 0,
  "module": "src/pages/orders",
  "title": "Order status display and related entry points",
  "scope": ["src/pages/orders"],
  "summary": "Current frontend behavior observed from these files; backend transitions remain unverified.",
  "entities": [{"name": "status", "meaning": "The response field used by this view."}],
  "flows": [{"name": "Display", "steps": ["Read response", "Map status to the visible label"]}],
  "rules": [{"description": "Describe only the observed responsibility.", "responsibility": "frontend"}],
  "related_paths": ["src/pages/orders/index.tsx"],
  "sources": [{"path": "src/pages/orders/index.tsx", "sha256": "exact indexed source hash", "line": 12, "quote": "exact source text beginning on this line"}],
  "questions": ["Which backend transition constraints are not visible in this repository?"]
}
```

Do not copy placeholder paths, hashes or evidence from this example. All source files must be included in `related_paths` and be indexed/current. Evidence quotes are checked against their line and current file hash; that validates provenance, not the meaning of the model. Preserve observations separately from unknown product intent in the summary/questions. `responsibility` is `frontend`, `backend`, `shared` or `unknown`.

For a new model use revision 0. For an update, retrieve the latest model and supply its revision, preserving relevant existing content. Old revisions remain immutable. A revision conflict requires rereading; a source change requires rescanning and reviewing current code. CLI equivalents: `project scan`, `project context --query ... --path ...`, and `model record --file ...`, each with `--project`.

Structure, history and model candidates support implementation decisions but never grant approval to modify other projects, run historical commands or confirm team rules. If a scan or model is unavailable, continue supported work from current files and state the limitation.
