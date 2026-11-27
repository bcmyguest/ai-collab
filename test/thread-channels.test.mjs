// Thread channels on the Postgres bus store (docs/threads.md "Thread channels"): the listening toggle, thread_messages
// since and limit, and a thread:<id> post fanned out to its listeners.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { test, after } from "node:test";
import { createBusServer } from "../lib/bus.ts";
import { openPostgresBusStore } from "../lib/bus-postgres.ts";
import { inboxTopic } from "../lib/config.ts";
import { pgUrl } from "../lib/postgres.ts";
import { sendMessage } from "../lib/messaging.ts";
import { channelClient } from "../lib/thread-channel-store.ts";
import { threadListen, threadMessages } from "../lib/thread-channels.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const TOKEN = "tk_channels";
const pgUp = await dbosTestDb();
const skip = !pgUp && "Postgres not reachable";
const { default: pg } = await import("pg");

const address = (peer, n) => `${peer}#${String(n).padStart(16, "0")}`;
const LEAD = address("claude", 1);
const CHILD = address("codex", 2);
const PEER = address("cursor", 3);
const OUTSIDER = address("claude", 4);

async function query(sql, params) {
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

/** A fresh Postgres bus store in its own schema behind a bus server, with one thread of LEAD, CHILD and PEER; drops the schema after. */
async function withChannel(fn) {
  const schema = `bus_th_${randomBytes(4).toString("hex")}`;
  const dir = tempDir({ after }, "ai-collab-channels-");
  const store = await openPostgresBusStore({ url: pgUrl(process.env), filesDir: path.join(dir, "files"), schema });
  const server = createBusServer({ store, token: TOKEN });
  const url = await server.listen();
  try {
    const { id } = await store.threads.create({ project: "demo", title: "Channel" });
    for (const session of [LEAD, CHILD, PEER]) await store.threads.moveSession(id, { session });
    const base = { url, token: TOKEN, timeoutMs: 5000, enabled: true, project: "demo", peers: ["claude", "codex", "cursor"], stateDir: path.join(dir, "state") };
    const as = (who) => (who === "operator" ? { ...base, peer: "operator", session: "" } : { ...base, peer: who.split("#")[0], session: who.split("#")[1] });
    return await fn({ store, schema, id, as, client: channelClient(base) });
  } finally {
    await server.close();
    await store.close();
    await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

const SESSIONS = [{ id: LEAD }, { id: CHILD, parent: LEAD }, { id: PEER }, { id: OUTSIDER }];

test("the listening toggle stores a setting per session, null clears it, and the project lists every setting", { skip }, () => withChannel(async ({ id, as, client, schema }) => {
  const set = await threadListen(as(CHILD), id, true, { client });
  assert.deepEqual(set, { thread: id, session: CHILD, listening: true });
  await client.setListening(id, OUTSIDER, true);
  await client.setListening(id, PEER, false);
  const channel = await client.channel(id);
  assert.deepEqual(channel.sessions, [
    { session: LEAD, member: true, listening: null },
    { session: CHILD, member: true, listening: true },
    { session: PEER, member: true, listening: false },
    { session: OUTSIDER, member: false, listening: true },
  ]);
  assert.deepEqual((await client.listeners("demo")).map((l) => l.session), [OUTSIDER, CHILD, PEER].sort());
  assert.deepEqual(await client.listeners("other"), []);
  await client.setListening(id, PEER, null);
  assert.equal((await client.channel(id)).sessions.find((s) => s.session === PEER).listening, null);
  await assert.rejects(client.setListening(id, "nope", true), (error) => error.status === 400);
  await assert.rejects(client.setListening("th_0000000000000000", PEER, true), (error) => error.status === 404);
  await assert.rejects(threadListen(as("operator"), id, true, { client }), /needs a session/);
  // A thread's settings go with it.
  await query(`DELETE FROM ${schema}.threads WHERE id = $1`, [id]);
  assert.deepEqual(await query(`SELECT * FROM ${schema}.thread_listeners`), []);
}));

test("a thread post reaches its listeners and mentions as inbox copies, once on the thread topic, never the sender", { skip }, () => withChannel(async ({ id, as, client, schema }) => {
  const sent = await sendMessage(as(LEAD), `thread:${id}`, "status: green", { client, sessions: SESSIONS, owned: [] });
  assert.deepEqual(sent.delivered, [PEER]);
  const mention = await sendMessage(as("operator"), `thread:${id}`, `check this @codex and @${OUTSIDER}`, { client, sessions: SESSIONS, owned: [] });
  assert.deepEqual(mention.delivered, [LEAD, CHILD, PEER, OUTSIDER]);
  const rows = await query(`SELECT id, topic, message, thread_id FROM ${schema}.events ORDER BY id`);
  const posts = rows.filter((r) => r.thread_id === id);
  assert.deepEqual(posts.map((r) => JSON.parse(r.message).body), ["status: green", `check this @codex and @${OUTSIDER}`]);
  assert.deepEqual(posts.map((r) => String(r.id)), [sent.id, mention.id]);
  const copies = rows.filter((r) => r.thread_id === null).map((r) => ({ topic: r.topic, ...JSON.parse(r.message) }));
  assert.deepEqual(copies.map((m) => `${m.to}#${m.toSession}`), [PEER, LEAD, CHILD, PEER, OUTSIDER]);
  assert.ok(copies.every((m) => m.threadId === id && /^\d+$/.test(m.channel)));
  assert.equal(copies[0].topic, inboxTopic("demo", "cursor"));
  assert.equal(copies[0].from, "claude");
  // The muted subagent hears nothing until it opts in.
  await threadListen(as(CHILD), id, true, { client });
  assert.deepEqual((await sendMessage(as(PEER), `thread:${id}`, "again", { client, sessions: SESSIONS, owned: [] })).delivered, [LEAD, CHILD]);
  await assert.rejects(sendMessage(as(LEAD), `thread:${id}`, "x", { client, sessions: SESSIONS, expectReply: true }), /expect_reply/);
  await assert.rejects(sendMessage(as(LEAD), "thread:th_0000000000000000", "x", { client, sessions: SESSIONS }), /Unknown thread/);
}));

test("thread_messages pages a thread's posts: the newest without since, the first after an id or a time, capped", { skip }, () => withChannel(async ({ id, as, client, schema }) => {
  const ids = [];
  for (let n = 1; n <= 5; n += 1) ids.push((await sendMessage(as(LEAD), `thread:${id}`, `post ${n}`, { client, sessions: SESSIONS, owned: [] })).id);
  const bodies = (page) => page.messages.map((m) => m.body);
  const latest = await threadMessages(as(PEER), id, { limit: 2, client });
  assert.deepEqual(bodies(latest), ["post 4", "post 5"]);
  assert.equal(latest.more, true);
  assert.equal(latest.title, "Channel");
  assert.equal(latest.messages[0].from, LEAD);
  const after = await threadMessages(as(PEER), `thread:${id}`, { since: ids[1], limit: 2, client });
  assert.deepEqual(bodies(after), ["post 3", "post 4"]);
  assert.equal(after.more, true);
  assert.deepEqual(bodies(await threadMessages(as(PEER), id, { since: ids[3], client })), ["post 5"]);
  // since as a time: every post at or after it; set two posts an hour back to split them.
  await query(`UPDATE ${schema}.events SET time = time - 3600 WHERE id = ANY($1::bigint[])`, [[ids[0], ids[1]]]);
  const since = new Date(Date.now() - 1800_000).toISOString();
  const recent = await threadMessages(as(PEER), id, { since, client });
  assert.deepEqual(bodies(recent), ["post 3", "post 4", "post 5"]);
  assert.equal(recent.more, false);
  await assert.rejects(threadMessages(as(PEER), id, { since: "yesterday", client }), /since/);
  await assert.rejects(threadMessages(as(PEER), id, { limit: 101, client }), /limit/);
  // Posts only: the inbox copies carry no thread_id, so the page never repeats a post per listener.
  assert.equal((await threadMessages(as(PEER), id, { limit: 100, client })).messages.length, 5);
}));
