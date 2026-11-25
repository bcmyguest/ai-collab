# Switchover plan: durable layer, language, and cleanup

Status: proposed 2026-11-25. Decisions D1 and D2 need the operator. Batches start after both are answered.

## 1. Review of the uncommitted ntfy-removal work (opencode#79f30a4e46706223)

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

Fixes 1-4 are assigned to opencode#79f30a4e46706223 (message 281).

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

## 3. Decisions for the operator

### D1. Durable layer and bus

| Option | New processes | Cost | Risk |
|---|---|---|---|
| **A. Keep SQLite `lib/bus.mjs` + `lib/durable.mjs`, fix findings** | 0 (bus service exists) | Low: batch 0 | Hand-rolled engine stays ours to maintain (about 770 lines) |
| B. celld for pattern runs only (extend the spike) | celld + bucket (MinIO) + gateway | Medium | Beta runtime, upgrades need full stop, unauthenticated admin API |
| C. celld for bus and durable | same as B | High: rewrite ntfy wire as a Worker | All of B, plus 60 s stream expiry for long subscriptions |

Recommendation: A now. Revisit B when celld reaches 1.0 or multi-machine ownership becomes a requirement.

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
| 0 | Review fixes 1-4 above; commit the ntfy-removal work per refactor-plan batch | qwen | `node --test test/sandbox-cap.test.mjs test/bus.test.mjs`, then full suite |
| 1 | Merge duplicates in the table above | qwen; Haiku per file | full suite |
| 2 | MCP servers on `@modelcontextprotocol/sdk`; CLI flags on `parseArgs` | Haiku | `node --test test/mcp*.test.mjs test/cli*.test.mjs` + full suite |
| 3 | TS foundation: core `tsconfig` (`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`), `tsc --noEmit` in CI; convert `config`, `transport`, `bus`, `durable`, `inbox` | qwen | `npx tsc --noEmit -p tsconfig.core.json` + full suite |
| 4 | Convert remaining files, leaf modules first, 10-15 files per batch | Haiku per file, qwen integrates | same |
| 5 | Split `runner/runner.mjs` and `lib/builder.mjs` by responsibility | qwen | full suite |

Review: one Opus subagent per batch, briefed with the branch and this document, never with the implementer's summary.
