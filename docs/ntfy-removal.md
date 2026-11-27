# ntfy removal: done

Status: done (2026-11-27). The ntfy container is gone, and so is the SQLite bus that first replaced it.
`lib/bus.ts` serves the ntfy wire subset from Postgres on this machine; `scripts/ai-collab-bus.mjs` is the
service. This document records what was built, why, and how an existing install switches over.

Landing commits:

| Commit | Date | Change |
|---|---|---|
| `7abcb758` | 2026-11-25 | The local bus (`lib/bus`, `scripts/ai-collab-bus.mjs`) replaces the ntfy container; `deploy/compose.yaml` deleted |
| `71ded041` | 2026-11-26 | Postgres bus store behind `AI_COLLAB_BUS_STORE` |
| `07d6c248` | 2026-11-26 | `ai-collab bus migrate --to postgres` |
| `df041ce9` | 2026-11-26 | Bus Postgres cutover runbook |
| `37278860` | 2026-11-27 | SQLite bus store (`bus.db`) retired; Postgres only |
| `3c513c10` | 2026-11-27 | Bus, Postgres and delivery modules ported to TypeScript |

## What replaced ntfy

The plugin only ever used five ntfy endpoints (`POST /`, `PUT /<topic>` for attachments, `GET /file/<id>`,
`GET /<topic>/json?poll=1`, `GET /<t1,t2>/json` streams) behind one client module, now `lib/messaging.ts`
(`lib/transport.mjs` re-exports it for older importers). The bus implements exactly that subset, plus the
`/threads` routes of [Threads](threads.md):

| Concern | ntfy (before) | bus (now) |
|---|---|---|
| Process | Docker container (`deploy/compose.yaml`) | systemd user service `ai-collab-bus` (or `node scripts/ai-collab-bus.mjs`) |
| Storage | ntfy cache.db, 12 h window | Postgres schema `bus` in the `ai_collab` database (`ai-collab postgres up`), retention 7 days (`AI_COLLAB_BUS_RETENTION_HOURS`); see [Bus store](configuration.md#bus-store) |
| Attachments | ntfy file store, 12 h expiry, bandwidth-limited | blobs under `<state dir>/bus/files/`, same retention, no bandwidth accounting |
| Auth | ntfy token, deny-all | same Bearer-token check, deny-all; setup writes the token to `~/.config/ai-collab/bus-token` |
| Rate limits | 429 handling, exempt-hosts config | none: loopback-only behind a shared token |
| Message cap | 4095 bytes (server quirk) | 64 KB on the wire; clients keep the 4095 cap so messages stay deliverable to an operator-run ntfy too |
| Test double | `test/helpers/fake-ntfy.mjs` (hand-written) | the same file name, now the production `lib/bus.ts` server on the memory store, so tests exercise production code |

The wire stays ntfy-compatible on purpose: `defaults.json` can still point `url` at a real ntfy server,
and `lib/messaging.ts` works against either. Threads need the bus: an ntfy server has no `/threads` routes,
and the UI then shows no thread list.

Names that kept their ntfy spelling: phone posts carry the sender `ntfy`, the runner's durable keys are
`ntfy:<event id>` and `ntfy-cursor:<project>`, the sandbox token file is `ntfy-token`, and errors carry
`ntfyStatus`.

## Why not a durable-run product instead

The research pass (2026-11-25) compared DBOS Transact TS, Temporal, Restate, Inngest, and Hatchet as the
"durable pod runs" engine, and NATS, Redis Streams, and Matrix as the bus:

- **DBOS Transact TS** (MIT) is the closest fit to `lib/durable.ts`, but the TypeScript SDK is Postgres-only;
  adopting it means running a database to replace a 370-line tested module that already provides stable ids,
  checkpointed steps, recovery, and dedup'd messages.
- **Temporal** and **Hatchet** need Postgres plus their own server processes: two stateful services for one user.
- **Restate** is a single binary but BSL 1.1 (not open source until each release's change date) and would mean
  rewriting the runner's workflows as HTTP handlers.
- **Inngest** self-host defaults to SQLite but its queue is an in-memory Redis with periodic snapshots: a
  crash-loss window exactly where "durable runs" is the point.
- **NATS / Redis** add a second bus duplicating what the durable store already is; the phone cannot speak
  either, so an SSE bridge is needed anyway.
- **Matrix** (synapse) is heavy machinery (Python + Postgres + E2EE) for a loopback system.

So the product boundary moved instead of growing: one small bus service plus the existing `lib/durable.ts`
core, with systemd supervising both. Postgres arrived anyway, for the DBOS engine: `"workflowEngine": "dbos"`
runs the runner's workflows on DBOS Transact over the same container, and the bus store moved onto it. The
SQLite durable log (`runner.db`) stays the code default; see [DBOS workflow engine](configuration.md#dbos-workflow-engine).

## Migration for an existing install

1. Stop the ntfy container: `docker compose -f deploy/compose.yaml down` (or your own ntfy). Keep it stopped
   with its restart policy off (`docker update --restart=no <name>`) so it cannot grab the port on reboot.
2. Start Postgres: `ai-collab postgres up`.
3. The bus reads `tokenFile` from `defaults.json`, so if it already points at the old ntfy token, every
   cached client config keeps working with nothing to do. To decouple, write the token to
   `~/.config/ai-collab/bus-token` and point `tokenFile` (or `AI_COLLAB_BUS_TOKEN_FILE`) at it.
4. Start the bus: `systemctl --user enable --now ai-collab-bus` (rerun `ai-collab setup` to install the unit).
   An install that ran the SQLite bus has a `bus.db`; copy it first with `ai-collab bus migrate --to postgres`
   ([Upgrading from the SQLite store](configuration.md#upgrading-from-the-sqlite-store-busdb)).
5. Restart the UI: a rebuilt `.next` under a running `next start` serves stale chunks. Restart the runner to
   load the new code. Old ntfy cursors are unknown ids to the bus, so the first read replays the topic and
   dedupe keys absorb the replay.

Rollback: any ntfy server on the same url and token works for messaging (`defaults.json` is the only knob);
threads do not.

## What the phone loses and keeps

The ntfy phone app has nothing to subscribe to now. The phone story is the PWA over Tailscale with Web
Push (installed via the UI): add the home-screen icon once, and alerts arrive the same way.
If you still want the ntfy app buzzing, run a one-way bridge that republishes bus events to your own ntfy
server; nothing in the system depends on it.
