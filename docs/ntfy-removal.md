# ntfy removal: implemented

Status: done (2026-11-25). The ntfy container is gone. `lib/bus.ts` serves the same wire subset from
SQLite on this machine; `scripts/ai-collab-bus.mjs` is the service; `deploy/compose.yaml` is deleted.
This document records what was built, why, and how an existing install switches over.

## What replaced ntfy

The plugin only ever used five ntfy endpoints (`POST /`, `PUT /<topic>` for attachments, `GET /file/<id>`,
`GET /<topic>/json?poll=1`, `GET /<t1,t2>/json` streams) behind one client module, now `lib/transport.mjs`.
The bus implements exactly that subset:

| Concern | ntfy (before) | bus (after) |
|---|---|---|
| Process | Docker container (`deploy/compose.yaml`) | systemd user service `ai-collab-bus` (or `node scripts/ai-collab-bus.mjs`) |
| Storage | ntfy cache.db, 12 h window | SQLite (WAL) at `<state dir>/bus/bus.db`, retention 7 days (`AI_COLLAB_BUS_RETENTION_HOURS`) |
| Attachments | ntfy file store, 12 h expiry, bandwidth-limited | blobs under `<state dir>/bus/files/`, same retention, no bandwidth accounting |
| Auth | ntfy token, deny-all | same Bearer-token check, deny-all; token at `~/.config/ai-collab/bus-token` |
| Rate limits | 429 handling, exempt-hosts config | none: loopback-only behind a shared token |
| Message cap | 4095 bytes (server quirk) | 64 KB on the wire; clients keep the 4095 cap so messages stay deliverable to an operator-run ntfy too |
| Test double | `test/helpers/fake-ntfy.mjs` (hand-written) | the same `lib/bus.ts` server on the memory store, so tests exercise production code |

The wire stays ntfy-compatible on purpose: `defaults.json` can still point `url` at a real ntfy server
(an operator's own, or a phone bridge), and `lib/transport.mjs` works against either.

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

So the product boundary moved instead of growing: one small bus service (this file) plus the existing
`lib/durable.ts` core, with systemd supervising both. The pre-approved escape hatch stays in
`docs/orchestration-migration-spike.md`: if `lib/durable.ts` ever outgrows itself, the pilot target is
DBOS Transact TS on a Postgres container, with the spike's tick-idempotency kill tests as the gate.

## Migration for an existing install

1. Stop the ntfy container: `docker compose -f deploy/compose.yaml down` (or your own ntfy).
2. The bus reads `tokenFile` from `defaults.json`, so if it already points at the old ntfy token, every
   cached client config keeps working with nothing to do. To decouple, write the token to
   `~/.config/ai-collab/bus-token` and point `tokenFile` (or `AI_COLLAB_BUS_TOKEN_FILE`) at it.
3. Start the bus: `systemctl --user enable --now ai-collab-bus` (rerun `ai-collab setup` to install the unit),
   or run `node scripts/ai-collab-bus.mjs` in the background. Keep the old container stopped with its restart
   policy off (`docker update --restart=no <name>`) so it cannot grab the port on reboot.
4. Restart the UI: a rebuilt `.next` under a running `next start` serves stale chunks. The runner keeps
   working without a restart (the wire is identical); restart it when convenient to load the new code.
   Old ntfy cursors are unknown ids to the bus, so the first read replays the topic and dedupe keys absorb
   the replay; nothing else to do.

Rollback: any ntfy server on the same url and token works unchanged (`defaults.json` is the only knob).

## What the phone loses and keeps

The ntfy phone app has nothing to subscribe to now. The phone story is the PWA over Tailscale with Web
Push (already installed via the UI): add the home-screen icon once, and alerts arrive the same way.
If you still want the ntfy app buzzing, run a one-way bridge that republishes bus events to your own ntfy
server; nothing in the system depends on it.
