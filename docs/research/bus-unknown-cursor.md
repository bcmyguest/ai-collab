# Unknown bus cursors: what happens today

> Historical: written before the switch from the SQLite bus store to Postgres only; see [Bus store](../configuration.md#bus-store).

Research for 4b batch 3, at main ba67eb79. A `since` names where a reader resumes: the cached poll `GET /<topic>/json?poll=1&since=` (lib/bus.ts:320-334) and the live stream `GET /<topics>/json?since=` (lib/bus.ts:336-365). `parseSince` sorts every value into all, time, id, or none (lib/bus.ts:43-54): "" and "all" read everything (lib/bus.ts:45), durations and 9+ digit unix seconds read by time (lib/bus.ts:46-51), any other digits read as an event id (lib/bus.ts:52), and anything else is none (lib/bus.ts:53).

An unknown cursor is an id the store cannot place: pruned away, newer than everything, not an id at all, or from another bus. Today no response says "unknown". Poll falls back to the whole topic, stream falls back to nothing, and each client absorbs the result its own way.

## (a) A pruned id, older than the oldest retained event

Prune deletes events by time on an hourly timer (lib/bus.ts:218-227, scripts/ai-collab-bus.mjs:45-47), so a stored cursor can name a row that no longer exists.

- Poll: the id existence check misses (lib/bus.ts:176) and the answer is the whole retained topic (lib/bus.ts:177; memory store lib/bus.ts:86). The client re-receives events it already processed: duplicates, no skips, no hang. Consumers are built for this — the fallback carries the comment "unknown id: everything, dedup must cope" (lib/bus.ts:86) — dispatch re-folds receipts into Sets (web/server/dispatch.mjs:154-161) and the runner dedupes deliveries by message id (runner/runner.mjs:1341,1359).
- Stream: backfill is a bare `id > since` with no existence check (lib/bus.ts:187; memory lib/bus.ts:95), so every retained event follows the pruned cursor. That is the correct continuation: events between the cursor and the oldest retained row are pruned and unrecoverable, and nothing already seen is re-sent. Live events continue from there (lib/bus.ts:354).
- Nothing in either answer distinguishes an unknown cursor from a normal one; a client cannot tell a full replay from a continuation.

## (b) An id newer than the newest event

- Poll: the existence check misses (lib/bus.ts:176), so the answer is again the whole retained topic (lib/bus.ts:177): the client sees every event again, duplicates. A future unix *time* is different: the time filter answers with nothing (lib/bus.ts:174), pinned by test/bus.test.mjs:56.
- Stream: `id > since` matches nothing (lib/bus.ts:187), so the backfill is empty. The client skips every existing event; live events still flow because `lastSeen` starts at 0 (lib/bus.ts:345-351). No hang: the server writes a keepalive every 30 s (lib/bus.ts:355-357) and the client's idle abort is 120 s (lib/transport.mjs:12,179).
- The runner persists its stream cursor and advances it only on a received event (runner/runner.mjs:1366,1370-1373), so a too-new cursor sticks: every reconnect backfills empty, and events published before the next live event stay skipped for that consumer.

## (c) Garbage (not an id, not a time)

`parseSince` sorts it to none (lib/bus.ts:53).

- Poll: none answers the whole topic (lib/bus.ts:180; memory lib/bus.ts:88): duplicates.
- Stream: none backfills nothing (lib/bus.ts:188; memory lib/bus.ts:96): the client skips all existing events and receives live events only.
- The two endpoints fail opposite ways: a garbage poll is everything, a garbage stream is nothing.

## (d) An id from another bus

Ids are per-store sequences — SQLite AUTOINCREMENT (lib/bus.ts:125,157-160), a memory counter (lib/bus.ts:60,65-67) — and the wire carries no provenance, so a foreign id is just a number.

- Poll: the existence check is scoped to the topic (lib/bus.ts:176), so an id that exists on another topic of the same bus already counts as unknown here and answers the whole topic. A foreign id missing from the store does the same (lib/bus.ts:177). A foreign id that happens to equal a retained local id is treated as a real cursor (lib/bus.ts:178): the client silently skips everything at or before it.
- Stream: `id > since` reads the foreign number as a local position (lib/bus.ts:187). Lower than the local range: events at or below it are skipped. Higher: empty backfill, live only. No error either way.

## What the clients do with it

- `pollCached` returns the wire events as-is (lib/transport.mjs:133-143). `messageEvent` keeps a fixed field set (lib/transport.mjs:161,168), so any new marker such as a reset flag is dropped before callers see it, and non-message lines (open, keepalive) never reach `streamEvents` consumers (lib/transport.mjs:161,199-200).
- The runner is the cursor-bearing stream client (runner/runner.mjs:1362-1380). The web hub streams by time, not id (web/server/hub.mjs:58), and its history poll reads "all" with a tail budget (web/server/hub.mjs:79). The console never sends a bus cursor: chat-stream.js keys its reconnect on the stream key (web/app/chat-stream.js:63,82,110-116) and re-renders from the hub's state, so bus cursor anomalies surface in runner delivery and ack folding, not in the console.
- The inbox reads from a committed id, or a unix lookback before the first commit (lib/inbox.mjs:294-301), so it takes the poll fallbacks above.
- test/bus-cursor.model.test.mjs encodes today's rules as its model (test/bus-cursor.model.test.mjs:78-91: unknown poll id → everything, backfill → `id > since`), and test/bus.test.mjs:55 pins "unknown id: everything, dedup copes". Batch 3 changes the server and must address both pins.

## The contract batch 3 must add

For every unknown cursor — pruned, future, garbage, foreign — the server replays from the oldest retained event and marks the replay: `reset: true` in the poll JSON and in the first stream line. That turns (b), (c) and the foreign-high form of (d) from silent skips into replays, gives (a) and every poll path a signal clients can act on instead of silent dedup, and transport.mjs must pass the marker through (lib/transport.mjs:161,168) before any client can use it. test/bus-unknown-cursor.test.mjs asserts this contract, one test per case, on SQLite and Postgres.

## Implemented in batch 3

- `resolve(topics, since)` on each store returns `{since, reset}`. A numeric id that exists in a subscribed topic keeps its since. Any other unknown value (pruned, future, garbage, foreign) returns `since: "all", reset: true`. Durations and unix seconds never reset. Poll checks the id against its topic; stream checks it against every subscribed topic.
- Poll puts `reset: true` on every JSON line of the replayed response, including the keepalive. Stream puts it on the open line. `messageEvent` keeps the flag, and `streamEvents` calls `onReset` once when the open line carries it.
- The runner, the dispatcher and the inbox log one line per response that carries a reset.
- The test (d) foreign id (8) sits above the local newest id (5). It covers only the non-colliding case.

## Known limitation: a colliding foreign id

A foreign id equal to a retained local id passes the existence check and reads as a real position: the client skips every event at or below it, and nothing marks the response. Detecting it needs a bus epoch or a provenance field on the cursor. Batch 3 adds neither. The id format stays unchanged.
