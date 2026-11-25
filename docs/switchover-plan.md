# Switchover plan: durable layer, language, and cleanup

Status: decided 2026-11-25. D1-A (DBOS Transact TS on Postgres; bus stays on SQLite) and D2-A (TypeScript in place, by module). Batches below are the work order.

## 1. Review of the ntfy-removal work

opencode#79f30a4e46706223 (qwen) committed the bus as 7abcb758 on main. By its account the runner boot sweep and the refactor-plan batches are another session's uncommitted work; that author is not yet identified.

Measured on the working copy of `~/ai-collab` main, 2026-11-25.

| Check | Result |
|---|---|
| Bus end to end (throwaway instance) | Pass: 401 without token, publish, poll, NDJSON stream, attachment upload and download, events and files survive restart |
| Live bus | `ai-collab-bus.service` active on 127.0.0.1:8794; operator and agent messages flow through it |
| Full suite `node --test` | 5 failures. 3 also fail on committed main (`activity`, `operator-messages`, `pm-workspace`). 1 fails only in the full run. 1 is a regression: `test/sandbox-cap.test.mjs` |

Findings, most severe first:

1. **Blocker.** `runner/runner.mjs` boot sweep (`isSandboxOwned` plus the loop before session recovery) deletes every OpenShell sandbox that no builder state file or live session names. It runs before sessions are recovered, so it deletes `ai-collab-code`, `aic-ro-*`, team and PM sandboxes, other projects' sandboxes and sessions about to resume. The running runner started before the edit; a restart loads it.
2. `lib/bus.mjs` `createBusServer` keeps `publishes`, `polls`, `subscribes` and `fileReads` arrays that grow without bound in the production service.
3. Test fault knobs (`failNext`, `limitNext`, `delayMs`, a fake 429) live in the production server.
4. About 119 files sit uncommitted on main, staged and unstaged mixed, while the bus service runs from that checkout.
5. Two stores (memory and SQLite) duplicate the query logic; tests mostly run the memory one.

Fixes 1-4 went to opencode#79f30a4e46706223 (message 281). 7abcb758 still contains findings 2 and 3. Finding 1 needs the sweep's author.

## 2. Research

### 2.1 celld as the durable layer

Source: celld docs and repository, read 2026-11-25.

| Fact | Value | Source |
|---|---|---|
| What | Self-hosted Durable Objects and Workflows runtime for Workers-style JS | https://celld.dev/docs |
| Owner, licence | Deno Land Inc., Apache-2.0; pull requests disabled, patches by email | https://github.com/denoland/celld |
| Maturity | v0.6.x beta; about 10 releases Aug-Oct; v0.4.1, v0.5.0 and v0.6.0 needed a full fleet stop to upgrade | https://github.com/denoland/celld/releases |
| Durable storage | Needs an S3-compatible bucket (S3, R2, Tigris, GCS, Azure). Only `celld dev` runs on local disk | https://celld.dev/docs/guarantees |
| Auth | Neither public requests nor the admin API are authenticated; the Worker checks tokens itself | https://celld.dev/docs/security |
| Workflows | `step.do` replay, `waitForEvent` (24 h default), 1 MiB step result cap, 30-day retention | https://celld.dev/docs/services/workflows |
| Queues | At-least-once, unordered, 128 KB messages, 4-day retention | https://celld.dev/docs/services/queues |
| Host access | Worker code cannot spawn processes; side effects go through `fetch` to a host gateway, which must persist dedup keys | spike: `tools/smoke-celld.mjs` |

Fit against this codebase:

| Piece | celld primitive | Still on the host | Gap |
|---|---|---|---|
| `lib/bus.mjs` publish, poll, stream | Durable Object per topic | Hooks and sandboxes call the Worker | ntfy wire rewritten in the Worker; unclaimed streams expire in 60 s |
| Attachments | R2 | none | Needs a bucket (MinIO or cloud) for durability |
| `lib/durable.mjs` workflows | Workflows | Process-spawning gateway | Beta; at-least-once steps |
| Pattern runs | One Workflow per run (spike exists) | Gateway launching roles | Persisted launch keys |
| `runner/schedules.mjs` | Cron Triggers | The command and its systemd scope | No `wakeOnTasks` equivalent |

Unverified: a search result claims Deno joined Cloudflare and is merging workerd and celld. Check before any adoption.

### 2.2 Libraries (versions from crates.io and npm, 2026-11-25)

| Area | Project code | Rust | TypeScript |
|---|---|---|---|
| MCP servers | `scripts/ai-collab-mcp.mjs` 91, `scripts/ai-collab-code-mcp.mjs` 100 (JSON-RPC by hand) | `rmcp` 3.11 (official) | `@modelcontextprotocol/sdk` 1.32 (official, MIT) |
| CLI flags | `lib/cli.mjs` 506 + 3 sub-CLIs, 997 total | `clap` 4.6 | `node:util` `parseArgs` (built in) or `commander` 15 |
| DOT | `lib/dot.mjs` 325 | `graphviz-rust` 0.9 | `@ts-graphviz/parser` last published 2022: keep own parser |
| Durable queue on SQLite | `lib/durable.mjs` 372 | `apalis` + `apalis-sqlite` 1.2 (queue, retries, DAG; not replay) | none mature: DBOS, pg-boss, graphile-worker need Postgres; BullMQ needs Redis |
| Claude agent SDK | `runner/adapters/claude.mjs` | no official crate | `@anthropic-ai/claude-agent-sdk` (official, in use) |
| AG-UI | `@ag-ui/core` in 9 files | community crates only | `@ag-ui/core` 1.0.5 (official, in use) |
| SQLite | `node:sqlite` | `rusqlite` 0.43 | `node:sqlite` (built in) |

Libraries replace an estimated 600-1,100 lines; the rest of each listed file is domain logic.

### 2.3 Inventory of the core

106 files in `lib/`, `runner/`, `scripts/`; 19,246 lines (`wc -l`). Read per file by three Haiku passes; duplication claims spot-checked.

| Verdict | Files | Lines | Meaning |
|---|---|---|---|
| KEEP | 90 | 16,456 | Domain logic |
| LIB | 10 | 2,219 | Contains plumbing a library replaces (only part of each file goes) |
| MERGE | 6 | 571 | Duplicates another module |
| DELETE | 0 | 0 | Every file has an importer |

Confirmed duplication:

| Duplicate | Copies | Keep |
|---|---|---|
| Sandbox staging and upload (`executables`, `uploadAll`, `upload`) | `lib/builder.mjs:961-1019`, `runner/sandbox-run.mjs:92-194` | One module in `runner/sandbox.mjs` |
| Model fallback list and labels | `lib/limit-alert.mjs` (`who`, `fallbackOf`, `replacementOptions`), `lib/builder.mjs` retry waterfall | `lib/fallback.mjs` |
| Atomic JSON write | `lib/state.mjs`, `lib/team-files.mjs`, `lib/alerts.mjs`, `lib/builder.mjs`; `lib/limit-alert.mjs` writes non-atomically | `lib/state.mjs` |
| Harness binary map | `lib/agent-guard.mjs` `HARNESS_BINARIES`, `lib/schedule-session.mjs` `BINARIES` | `lib/agent-guard.mjs` |
| Delivery backoff constants | `lib/deliver-push.mjs`, `runner/delivery.mjs` | `runner/delivery.mjs` |
| Re-export shim | `runner/durable.mjs` (1 line) | `lib/durable.mjs` |

Conclusion: the code is mostly product logic. Libraries and merges remove roughly 1,500-2,000 lines (estimate); the size problem is concentrated in `lib/builder.mjs` (1,326) and `runner/runner.mjs` (1,409).

### 2.4 Durable engines with Postgres allowed

| Option | Licence | Processes | Fit for `lib/durable.mjs` | Source |
|---|---|---|---|---|
| DBOS Transact TS 5.7.0 | MIT | app + Postgres; Conductor optional | High: `durable.mjs` copies its model | https://github.com/dbos-inc/dbos-transact-ts |
| Absurd | Apache-2.0 | Postgres + worker | Medium-high; no tagged release found | https://github.com/earendil-works/absurd |
| Temporal | MIT | dev server + worker; production adds services | Medium; heavy | https://github.com/temporalio/temporal |
| Hatchet | MIT | server + Postgres | Medium | https://github.com/hatchet-dev/hatchet |
| Restate | BSL 1.1 | one binary | Medium; HTTP push model | https://github.com/restatedev/restate |
| Inngest | SSPL server | `inngest start` | Low-medium | https://www.inngest.com/docs/self-hosting |
| pg-boss | MIT | Postgres | Low: jobs only, no step replay or send/recv | https://github.com/timgit/pg-boss |

`lib/durable.mjs` mapped to DBOS (https://docs.dbos.dev/typescript/reference/methods):

| durable.mjs | DBOS |
|---|---|
| `startWorkflow`, `startWorkflowOnce` | `DBOS.startWorkflow(fn, {workflowID})`; the id is the idempotency key |
| `wf.step` | `DBOS.runStep(fn, {name, retriesAllowed, maxAttempts})` |
| `send`, `recv` | `DBOS.send(dest, msg, topic, idempotencyKey)`, `DBOS.recv(topic, {timeout})` |
| recovery | automatic at `DBOS.launch()` |
| `cancel`, `status`, `listNamed` | `cancelWorkflow`, `retrieveWorkflow`, `listWorkflows` |
| `scheduled({everyMs})` | `DBOS.createSchedule` (cron, backfill) |
| `drain`, `pendingCount`, `prune` | no equivalent found; to verify in batch 2 |

Nothing found built on celld. Cloudflare's 2026-10-09 post (https://blog.cloudflare.com/deno-joins-cloudflare/) says Deno is joining Cloudflare and celld's ideas will be ported into workerd.

### 2.5 Duplication inside the domain code

One Opus pass read the code by concept. Line references are to `main` at 5897fbf7. Two claims spot-checked (marked ✓).

| Concept | Copies | Kind | Removable (est.) |
|---|---|---|---|
| Per-harness command lines | `lib/start.mjs:76`, `lib/builder.mjs:179`, `lib/controls.mjs:40`, `lib/team-author.mjs:221`, `lib/deliver-push.mjs:42`, `lib/interrupt.mjs:18` | Divergent: Cursor runs as `agent` in controls, `cursor-agent` in builder ✓ | 50 |
| `harness:model` parsing | 8 places across config, builder, limit-alert, teams, patterns, dot, team-author | Divergent validation | 40 |
| Fallback model literal | 6 copies | Same constant | 10 |
| Limit detection | `lib/limits.mjs:125,158`; `lib/builder.mjs:600-622` own regex and state file | Divergent | 30 |
| Phone reply matching | `lib/approvals.mjs:138`, `lib/questions.mjs:176,243` | Same loop 3 times | 60 |
| Approval cards | `lib/approvals.mjs:93` fits size; `lib/questions.mjs:222`, `lib/limit-alert.mjs:238` skip it | Divergent | 28 |
| Deadline wait loops | `lib/agents.mjs:46,78,101,124`, `lib/waiter.mjs:57`, `lib/stop.mjs` | Same skeleton 6 times | 50 |
| Push delivery | `runner/delivery.mjs:24` (durable) vs `web/server/dispatch.mjs:63-210` (in memory) | Two engines | 120 |
| Codex JSON-RPC client | `lib/codex-compact.mjs:13`, `runner/adapters/codex.mjs:49` | Same | 35 |
| Sandbox operations | `runner/sandbox.mjs`, `runner/sandbox-run.mjs`, `lib/builder.mjs` | Same, drifting | 130 |
| `projects.json` writes | `lib/teams.mjs:59,66,195,208` write without `underProjectsLock` (`lib/patterns.mjs:326`) ✓ | **Race: concurrent edits lose updates** | 35 |
| JSON file writers | 8 writers; 2 non-atomic, 2 without mode 0600 | Divergent | 60 |
| CLI vs MCP surfaces | `lib/cli.mjs:416` vs `lib/tool-api.mjs:277`; task fields differ | Parallel, divergent | 50 |

About 800 lines, and three behaviour bugs (Cursor binary, the `projects.json` race, oversized approval cards).

Proposed segmentation, 12 modules:

| Module | Owns | Folds in |
|---|---|---|
| `store` | atomic JSON, locks, state paths | `state`, writers in builder/tasks/alerts/teams/limit-alert |
| `harness` | one descriptor per harness: binary, argv by kind, model parsing, limit classifier | argv parts of start/controls/builder/team-author, `models`, `limits`, `idle`, codex RPC |
| `messaging` | send, claim, inbox, respond, one `waitUntil` | `inbox`, `agents`, `receipts`, `waiter`, stop's waiting |
| `delivery` | pushing into live sessions | `deliver-push`, `claude-socket`, `runner/delivery`, `web/server/dispatch` |
| `operator` | questions, approvals, AFK, one reply matcher | `questions`, `approvals`, `mode`, stop's policy |
| `sessions` | registry, launch, interrupt, controls | `sessions`, `owned`, `start`, `interrupt`, `controls`, `names`, `scope` |
| `limits` | detection, fallback chain, limit cards | `limit-alert`, `start-limit`, `fallback`, builder's retry |
| `sandbox` | OpenShell create, upload, land, destroy | `runner/sandbox`, `sandbox-run`, builder staging, code-run setup |
| `builder` | builder lifecycle only | rest of `lib/builder.mjs` |
| `workflows` | durable runs, schedules, tasks | `durable` (or DBOS), `pattern-runs`, `pattern-workflow`, `schedules`, `tasks` |
| `catalog` | teams, patterns, DOT | `patterns`, `teams`, `team-files`, `dot`, `pattern-compiler`, `team-author` |
| `surfaces` | one operation table rendered as CLI, MCP and control socket | `tool-api`, `cli`, `*-cli`, MCP scripts, `runner/control` |

## 3. Decisions for the operator

### D1. Durable layer and bus

Revised 2026-11-25 after the operator allowed Postgres. See 2.4.

| Option | New processes | Removes | Risk |
|---|---|---|---|
| **A. DBOS Transact TS on Postgres for workflows; keep `lib/bus.mjs` on SQLite** | Postgres | `lib/durable.mjs` (372) and ~100-200 lines of schedule and delivery plumbing | Every `durable.status`/`drain` call site becomes async (38 references in `runner/runner.mjs`); runner tests need rework; Postgres becomes a hard dependency |
| B. Absurd on Postgres | Postgres + worker | same as A | Young, no tagged release found; send/recv map onto events |
| C. Keep SQLite `lib/durable.mjs` | 0 | nothing | ~770 hand-rolled lines stay ours |
| D. celld | celld + S3-style bucket + host gateway | durable and possibly bus | Beta; nothing found built on it; Cloudflare is porting its features into workerd (blog, 2026-10-09) |

The bus stays on SQLite in A-C: sandboxes, hooks and the phone need its plain HTTP surface, and no Postgres option provides one without another adapter.

Recommendation: A.

### D2. Language for the core

| Option | Cost | Gains | Losses |
|---|---|---|---|
| **A. TypeScript in place** | File-by-file; Node 26.13 runs `.ts` directly (verified) | Official SDKs for Claude, AG-UI, MCP stay; types shared with `web/`; no build step | Types checked by `tsc --noEmit`, not at runtime |
| B. Rust rewrite | Port 19,246 lines; tests become fixtures | One static binary, fast hook start, compile-time types; `rmcp`, `clap`, `apalis-sqlite` | No official Claude agent or AG-UI crate; two languages (Rust core, TS web) |
| C. Rust for hooks and the bus only | Port `scripts/ai-collab-hook.mjs`, `lib/bus.mjs` and their imports | Fast hook start where it matters | Shared logic split across two languages |

Recommendation: A.

## 4. Batches (assuming D1-A and D2-A)

Every batch: implementer works on its own branch, runs the gate, commits with the gate output in the message body, and pings this session. An Opus reviewer reads the diff before merge. Baseline failures (3 on main) must not grow.

| # | Work | Implementer | Gate |
|---|---|---|---|
| 0 | Review fixes 1-4 above | qwen | `node --test test/sandbox-cap.test.mjs test/bus.test.mjs`, then full suite |
| 1 | Bug fixes from 2.5: `projects.json` lock, one Cursor binary, sized approval cards; each with a failing test first | qwen | new tests + full suite |
| 2 | TS foundation: core `tsconfig` (`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`), `tsc --noEmit` in CI; create `store` and `harness` modules in `.ts` | qwen | `npx tsc --noEmit -p tsconfig.core.json` + full suite |
| 3 | Segment by module, one module per batch, in order: `store`, `harness`, `sandbox`, `limits`, `operator`, `messaging`, `delivery`, `sessions`, `catalog`, `surfaces`, `builder`. Each batch moves code into one `.ts` module and deletes the copies | Haiku per file, qwen integrates | same |
| 4 | `workflows` on DBOS: Postgres user service, port `lib/durable.mjs` call sites, schedules, delivery, pattern runs | qwen | runner and pattern tests + a kill-and-recover test |
| 5 | Libraries at the `surfaces` edge: `@modelcontextprotocol/sdk`, `parseArgs` | Haiku | `node --test test/mcp*.test.mjs` + full suite |

Review: one Opus subagent per batch, briefed with the branch and this document, never with the implementer's summary.
