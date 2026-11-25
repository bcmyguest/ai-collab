// The local message bus: SQLite durability, retention, since-semantics, attachments, auth, streams.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBusServer, openBusStore, openMemoryStore, parseSince } from "../lib/bus.mjs";
import { pollCached, publish, streamEvents } from "../lib/transport.mjs";

const TOKEN = "tk_bus_test";

async function bus({ token = TOKEN, ...storeArgs } = {}) {
  const store = storeArgs.file ? openBusStore(storeArgs) : openMemoryStore();
  const server = createBusServer({ store, token });
  const url = await server.listen();
  const cfg = { url, token, timeoutMs: 2000 };
  return {
    url, cfg, store, server, state: server.state,
    close: async () => { await server.close(); store.close(); },
  };
}

test("parseSince reads the four forms clients send", () => {
  assert.deepEqual(parseSince("all"), { kind: "all" });
  assert.deepEqual(parseSince(""), { kind: "all" });
  assert.equal(parseSince("12h").kind, "time");
  assert.equal(parseSince("90m").value, parseSince("5400s").value);
  assert.deepEqual(parseSince("1764000000"), { kind: "time", value: 1764000000 });
  assert.deepEqual(parseSince("42"), { kind: "id", value: 42 });
  assert.deepEqual(parseSince("zz9"), { kind: "none" });
});

test("sqlite events survive a store restart and prune at retention", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-bus-"));
  const file = path.join(dir, "bus.db");
  const first = await bus({ file, filesDir: path.join(dir, "files") });
  t.after(() => first.close());
  await publish(first.cfg, "t", "durable");
  await first.close();

  const second = await bus({ file, filesDir: path.join(dir, "files"), retentionMs: -1 });
  t.after(() => second.close());
  assert.deepEqual((await pollCached(second.cfg, "t", "all")).map((e) => e.message), ["durable"]);
  second.store.prune();
  assert.deepEqual(await pollCached(second.cfg, "t", "all"), [], "retention prunes past events");
});

test("since selects: all, id, unknown id, and unix time", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  const a = await publish(b.cfg, "t", "a");
  await publish(b.cfg, "t", "b");
  assert.deepEqual((await pollCached(b.cfg, "t", "all")).map((e) => e.message), ["a", "b"]);
  assert.deepEqual((await pollCached(b.cfg, "t", a)).map((e) => e.message), ["b"]);
  assert.deepEqual((await pollCached(b.cfg, "t", "9999")).map((e) => e.message), ["a", "b"], "unknown id: everything, dedup copes");
  assert.deepEqual((await pollCached(b.cfg, "t", String(Math.floor(Date.now() / 1000) + 60))).map((e) => e.message), [], "future time: nothing");
});

test("attachments round-trip: PUT stores the file, GET serves it, the event carries the url", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-bus-"));
  const b = await bus({ file: path.join(dir, "bus.db"), filesDir: path.join(dir, "files") });
  t.after(() => b.close());
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const res = await fetch(`${b.url}/t?message=${encodeURIComponent(JSON.stringify({ text: "shot" }))}&filename=shot.png`, {
    method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: png,
  });
  assert.equal(res.status, 200);
  const ev = await res.json();
  assert.equal(ev.attachment.name, "shot.png");
  assert.match(ev.attachment.url, /\/file\/[a-f0-9]+\.png$/);
  const file = ev.attachment.url.slice(ev.attachment.url.lastIndexOf("/") + 1);
  assert.deepEqual(readdirSync(path.join(dir, "files")), [file]);
  const got = await fetch(`${b.url}/file/${file}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  assert.equal((await fetch(`${b.url}/file/nope.png`)).status, 401, "file reads need the token too");
});

test("a wrong token is refused everywhere, an empty-token bus needs none", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  const res = await fetch(`${b.url}/`, { method: "POST", body: JSON.stringify({ topic: "t", message: "x" }) });
  assert.equal(res.status, 401);
  const open = await bus({ token: "" });
  t.after(() => open.close());
  await publish(open.cfg, "t", "open");
  assert.deepEqual((await pollCached(open.cfg, "t", "all")).map((e) => e.message), ["open"]);
});

test("a stream backfills from since, then delivers live events for its topics only", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  const first = await publish(b.cfg, "mine", "backlog");
  await publish(b.cfg, "theirs", "other topic");
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const got = [];
  const done = (async () => {
    try {
      for await (const ev of streamEvents(b.cfg, ["mine"], { since: "all", signal: ctrl.signal })) {
        got.push(`${ev.topic}:${ev.message}`);
        if (got.length === 3) ctrl.abort();
      }
    } catch { /* aborted */ }
  })();
  await publish(b.cfg, "mine", "live");
  await publish(b.cfg, "theirs", "ignored");
  await publish(b.cfg, "mine", "last");
  await done;
  assert.deepEqual(got, ["mine:backlog", "mine:live", "mine:last"]);
  assert.ok(first);
});

test("a stream from an id cursor gets only newer events", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  const a = await publish(b.cfg, "t", "a");
  await publish(b.cfg, "t", "b");
  const ctrl = new AbortController();
  const seen = [];
  const done = (async () => {
    try {
      for await (const ev of streamEvents(b.cfg, ["t"], { since: String(Number(a) + 1), signal: ctrl.signal })) seen.push(ev.message);
    } catch { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, 150));
  await publish(b.cfg, "t", "c");
  await new Promise((r) => setTimeout(r, 150));
  ctrl.abort();
  await done;
  assert.deepEqual(seen, ["c"]);
});

test("poll tailBytes keeps the newest events when the topic outgrows the cap", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  for (let i = 0; i < 300; i += 1) await publish(b.cfg, "big", `${i}:${"x".repeat(500)}`);
  const tail = await pollCached(b.cfg, "big", "all", undefined, { tailBytes: 20_000 });
  assert.ok(tail.length > 0 && tail.length < 300, `kept ${tail.length} of 300`);
  assert.equal(tail.at(-1).message.startsWith("299:"), true, "newest kept");
});

test("the bus accepts a 5 KB message, so the 4095 client cap is policy, not the wire", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  const body = JSON.stringify({ topic: "t", message: "y".repeat(5000) });
  const res = await fetch(`${b.url}/`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
  assert.equal(res.status, 200);
});

test("the production server keeps no request log and no fault knobs", async (t) => {
  const b = await bus();
  t.after(() => b.close());
  await publish(b.cfg, "t", "a");
  await pollCached(b.cfg, "t", "all");
  assert.equal(b.server.state, undefined, "no per-request arrays on the production server");
  const res = await fetch(`${b.url}/`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ topic: "t", message: "x" }) });
  assert.equal(res.status, 200, "no injected failure without a test hook");
});
