# Orchestration migration spike

> Historical: written before the switch to the Postgres bus and the opt-in DBOS engine; see [DBOS workflow engine](configuration.md#dbos-workflow-engine) and [ntfy removal](ntfy-removal.md).

Use DBOS Transact for TypeScript as the integration target, based on the runner's [DBOS-shaped execution contract](owned-sessions-contract.md#durable-execution). Start with opt-in scheduled workflows and a PostgreSQL system database. This is a design review. SDK integration and crash behavior still need a live proof.

## Integration review

| Runner contract | Proposed mapping and review finding |
|---|---|
| Workflow registration and identity | Use `DBOS.registerWorkflow` and explicit IDs with `DBOS.startWorkflow`. Preserve the existing IDs for scheduled ticks. A stable workflow ID deduplicates workflow starts. |
| Replay and `onCut` | Use `DBOS.runStep` for replayable work. For a command or harness send, persist an attempt marker under a stable operation ID before invoking the external action. On re-entry, return a saved outcome or treat an existing marker without an outcome as interrupted. A crash between writing the marker and invoking the action can skip the action, consistent with avoiding a duplicate after an ambiguous crash. |
| Schedule and control semantics | Keep the existing scheduler and control socket as entry points. Prove parity for latest-due-only catch-up, task wakes, manual runs, overlap rules and interrupted commands before routing a schedule to DBOS. |
| Input and delivery | Defer session, pattern, wake and delivery workflows. Preserve batched receive order, source-event deduplication and inbox reservations before switching those paths. The ntfy cursor must advance only after the corresponding input is durably recorded. |

DBOS checkpoints completed steps in PostgreSQL and may re-execute an interrupted step during recovery. The attempt marker therefore needs to persist independently of the step checkpoint. Validate this with the SDK version selected for implementation. [DBOS architecture](https://docs.dbos.dev/architecture) · [TypeScript workflow IDs](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) · [Recovery](https://docs.dbos.dev/production/workflow-recovery)

## Pilot and rollback

Route one test schedule through DBOS under the existing single-runner lock. At cutover, pause dispatch and settle its SQLite workflows. Persist the routing choice and last issued tick before resuming so the two stores cannot independently issue the same tick. Leave existing SQLite histories with their original backend.

Use a command that appends its tick ID to a file. Kill and restart the runner before the attempt marker, after the marker, after the append but before outcome persistence, and after checkpoint completion. Check that each tick appends at most once, ambiguous attempts appear as interrupted, and completed ticks retain their outcome. Also check repeated triggers, overlap and downtime catch-up through the existing control routes.

For rollback, pause dispatch, settle or record interrupted DBOS attempts, and carry the last issued tick back to SQLite before enabling dispatch. Exercise rollback with a previously issued tick and confirm it never appends again. Expand beyond the pilot once these checks pass and the deployment has PostgreSQL backup and restore coverage.
