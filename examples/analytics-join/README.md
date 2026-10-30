# Analytics join example (synthetic)

`evaluation-result.json` is a lab result for an output that came from a fictional
Workspace job. `jobs.jsonl` holds the matching fictional line in the Workspace
Analytics export format v1.1 (`ANALYTICS_EXPORT_SCHEMA_v1.1.md`, §4).

They join on the result's `workspace.job` + `workspace.piece` + `workspace.phase`
(the Analytics line's `id` is `<job>:<piece>:<phase>`), and agree on `model`,
`effort` and provider (`model.provider` ↔ the line's `worker`). See
`src/domain/extensions/analyticsJoin.ts` and `docs/ARCHITECTURE.md`.
`tests/analyticsJoin.test.ts` checks that the ids line up.

The lab never reads Analytics files; this pair only documents the contract.
The `kind` value of the line is illustrative: the schema requires a `kind` but
the join does not use it.
