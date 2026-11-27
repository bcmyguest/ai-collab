// Threads on the Postgres bus store (docs/threads.md): idempotent schema, backfill grouping, spawn children, PR stacks,
// operator messages that carry a thread, and the /threads routes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { test, after } from "node:test";
import { createBusServer, openMemoryStore } from "../lib/bus.mjs";
import { openPostgresBusStore } from "../lib/bus-postgres.mjs";
import { pgUrl } from "../lib/postgres.mjs";
import { sendMessage } from "../lib/messaging.ts";
import { threadClient } from "../lib/thread-routes.mjs";
import { threadSessionsOf } from "../lib/threads.mjs";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const TOKEN = "tk_threads";
const ROOT = "/repo/demo";
const TREE = `${ROOT}/.claude/worktrees/ai-collab-codex-1`;
const pgUp = await dbosTestDb();
const skip = !pgUp && "Postgres not reachable";
const { default: pg } = await import("pg");

const address = (peer, n) => `${peer}#${String(n).padStart(16, "0")}`;

async function query(sql, params) {
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

/** A fresh Postgres bus store in its own schema behind a bus server; drops the schema after. */
async function withStore(fn) {
  const schema = `bus_th_${randomBytes(4).toString("hex")}`;
  const dir = tempDir({ after }, "ai-collab-threads-");
  const opened = [];
  const open = async () => {
    const store = await openPostgresBusStore({ url: pgUrl(process.env), filesDir: path.join(dir, "files"), schema });
    opened.push(store);
    return store;
  };
  const store = await open();
  const server = createBusServer({ store, token: TOKEN });
  const url = await server.listen();
  try {
    return await fn({ store, schema, open, cfg: { url, token: TOKEN, timeoutMs: 5000 } });
  } finally {
    await server.close();
    for (const s of opened) await s.close();
    await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

const threadOf = (threads, session) => threads.find((thread) => thread.sessions.includes(session));

test("opening the store twice keeps one schema: tables, the events column, and rows survive", { skip }, () => withStore(async ({ store, schema, open }) => {
  const made = await store.threads.create({ project: "demo", title: "first", worktree: TREE });
  const again = await open();
  const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
  assert.deepEqual(tables.map((row) => row.table_name), ["events", "files", "thread_prs", "thread_sessions", "threads"]);
  const column = await query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'events' AND column_name = 'thread_id'", [schema]);
  assert.equal(column.length, 1);
  assert.equal((await again.threads.get(made.id)).title, "first");
}));

test("backfill groups sessions by worktree, gives each root session its own thread, and a second run changes nothing", { skip }, () => withStore(async ({ store }) => {
  const sessions = [
    { address: address("codex", 1), cwd: TREE, worktree: TREE },
    { address: address("claude", 2), cwd: `${TREE}/web`, worktree: TREE },
    { address: address("cursor", 3), cwd: ROOT, worktree: "" },
    { address: address("claude", 4), cwd: ROOT, worktree: "" },
  ];
  const first = await store.threads.sync({ project: "demo", root: ROOT, sessions });
  assert.equal(first.assigned.length, 4);
  assert.equal(first.created, 3);
  const threads = await store.threads.list({ project: "demo" });
  assert.equal(threads.length, 3);
  const tree = threadOf(threads, address("codex", 1));
  assert.deepEqual(tree.sessions, [address("codex", 1), address("claude", 2)]);
  assert.equal(tree.worktree, TREE);
  assert.notEqual(threadOf(threads, address("cursor", 3)).id, threadOf(threads, address("claude", 4)).id);
  assert.equal(threadOf(threads, address("cursor", 3)).worktree, ROOT);

  const second = await store.threads.sync({ project: "demo", root: ROOT, sessions });
  assert.deepEqual(second, { assigned: [], created: 0 });
  assert.equal((await store.threads.list({ project: "demo" })).length, 3);
  assert.deepEqual(await store.threads.list({ project: "other" }), []);
}));

test("pattern-run members share the run's thread, also when the run works in the project root", { skip }, () => withStore(async ({ store }) => {
  const sessions = [
    { address: address("claude", 5), cwd: ROOT, worktree: "", patternRun: "run1" },
    { address: address("codex", 6), cwd: ROOT, worktree: "", patternRun: "run1" },
  ];
  await store.threads.sync({ project: "demo", root: ROOT, sessions });
  const [thread] = await store.threads.list({ project: "demo" });
  assert.equal(thread.patternRun, "run1");
  assert.deepEqual(thread.sessions, [address("claude", 5), address("codex", 6)]);
}));

test("a spawned child joins its parent's thread in the same worktree and gets a child thread in its own", { skip }, () => withStore(async ({ store }) => {
  const parent = address("claude", 7);
  const other = `${ROOT}/.claude/worktrees/ai-collab-cursor-2`;
  // Children come first in the input: assignment still places the parent before them.
  const sessions = [
    { address: address("codex", 8), cwd: ROOT, worktree: "", parent },
    { address: address("cursor", 9), cwd: other, worktree: other, parent },
    { address: parent, cwd: ROOT, worktree: "" },
  ];
  await store.threads.sync({ project: "demo", root: ROOT, sessions });
  const threads = await store.threads.list({ project: "demo" });
  const home = threadOf(threads, parent);
  assert.deepEqual(home.sessions, [parent, address("codex", 8)]);
  const child = threadOf(threads, address("cursor", 9));
  assert.notEqual(child.id, home.id);
  assert.equal(child.parentThreadId, home.id);
  assert.equal(child.worktree, other);
}));

test("sync gives a thread created before its session had a folder that session's worktree and branch", { skip }, () => withStore(async ({ store }) => {
  const { id } = await store.threads.create({ project: "demo", title: "from a start" });
  await store.threads.moveSession(id, { session: address("codex", 1) });
  const result = await store.threads.sync({ project: "demo", root: ROOT, sessions: [{ address: address("codex", 1), cwd: TREE, worktree: TREE, branch: "feat/x" }] });
  assert.deepEqual(result, { assigned: [], created: 0 });
  const thread = await store.threads.get(id);
  assert.equal(thread.worktree, TREE);
  assert.equal(thread.branch, "feat/x");
}));

test("PRs stack in order: append, insert at a position, detach closes the gap", { skip }, () => withStore(async ({ store }) => {
  const { id } = await store.threads.create({ project: "demo", title: "stack", worktree: TREE, branch: "feat/a" });
  await store.threads.attachPr(id, { number: 10, head: "feat/a", base: "main" });
  await store.threads.attachPr(id, { number: 12, head: "feat/c", base: "feat/a" });
  let thread = await store.threads.attachPr(id, { url: "https://example.invalid/pr/11", head: "feat/b", base: "feat/a", position: 1, state: "draft" });
  assert.deepEqual(thread.prs.map((pr) => [pr.position, pr.head, pr.state]), [[0, "feat/a", "open"], [1, "feat/b", "draft"], [2, "feat/c", "open"]]);
  thread = await store.threads.detachPr(id, thread.prs[1].id);
  assert.deepEqual(thread.prs.map((pr) => [pr.position, pr.number]), [[0, 10], [1, 12]]);
  await assert.rejects(store.threads.attachPr(id, { head: "feat/d", base: "main" }), (error) => error.status === 400);
  await assert.rejects(store.threads.attachPr(id, { number: 13, head: "feat d", base: "main" }), (error) => error.status === 400);
}));

test("status, pin and rename update the thread; list puts pinned first and hides archived", { skip }, () => withStore(async ({ store }) => {
  const a = await store.threads.create({ project: "demo", title: "a" });
  const b = await store.threads.create({ project: "demo", title: "b" });
  const c = await store.threads.create({ project: "demo", title: "c" });
  await store.threads.update(a.id, { pinned: true, title: "a2" });
  await store.threads.update(c.id, { status: "archived" });
  await assert.rejects(store.threads.update(b.id, { status: "working" }), (error) => error.status === 400);
  assert.deepEqual((await store.threads.list({ project: "demo" })).map((t) => t.title), ["a2", "b"]);
  assert.deepEqual((await store.threads.list({ project: "demo", archived: true })).map((t) => t.title).sort(), ["a2", "b", "c"]);
  await assert.rejects(store.threads.get("th_0000000000000000"), (error) => error.status === 404);
}));

test("an operator message sent in a thread carries the id in its envelope and on its event row", { skip }, () => withStore(async ({ store, schema, cfg }) => {
  const { id } = await store.threads.create({ project: "demo", title: "chat" });
  const operator = { ...cfg, enabled: true, project: "demo", peer: "operator", session: "", peers: ["claude"], stateDir: tempDir({ after }, "ai-collab-threads-state-") };
  await sendMessage(operator, address("claude", 1), "hello", { threadId: id });
  const [row] = await query(`SELECT message, thread_id FROM ${schema}.events`);
  assert.equal(row.thread_id, id);
  assert.equal(JSON.parse(row.message).threadId, id);
  await assert.rejects(sendMessage(operator, address("claude", 1), "hello", { threadId: "nope" }), /threadId/);
}));

test("the /threads routes drive the store over HTTP, and a store without threads answers 404", { skip }, () => withStore(async ({ cfg }) => {
  const client = threadClient(cfg);
  const made = await client.create({ project: "demo", title: "over http", worktree: TREE });
  await client.moveSession(made.id, address("codex", 1));
  await client.update(made.id, { status: "snoozed" });
  const withPr = await client.attachPr(made.id, { number: 3, head: "feat/x", base: "main" });
  assert.equal(withPr.prs.length, 1);
  const [listed] = await client.list("demo");
  assert.equal(listed.status, "snoozed");
  assert.deepEqual(listed.sessions, [address("codex", 1)]);
  await assert.rejects(client.update(made.id, { status: "bogus" }), (error) => error.status === 400);

  const memory = openMemoryStore();
  const server = createBusServer({ store: memory, token: TOKEN });
  const url = await server.listen();
  try {
    await assert.rejects(threadClient({ ...cfg, url }).list("demo"), (error) => error.status === 404);
  } finally {
    await server.close();
    memory.close();
  }
}));

test("threadSessionsOf merges registry sessions and owned records by address, owned fields first", () => {
  const sessions = threadSessionsOf({
    root: ROOT,
    sessions: [
      { id: address("claude", 1), cwd: `${TREE}/lib`, name: "fixer" },
      { id: address("codex", 2), cwd: "relative" },
    ],
    owned: [
      { address: address("claude", 1), cwd: TREE, parent: address("codex", 3), patternRun: "r1" },
      { address: address("cursor", 4), cwd: ROOT },
    ],
  });
  const byAddress = Object.fromEntries(sessions.map((s) => [s.address, s]));
  assert.deepEqual(Object.keys(byAddress).sort(), [address("claude", 1), address("cursor", 4)]);
  assert.equal(byAddress[address("claude", 1)].worktree, TREE);
  assert.equal(byAddress[address("claude", 1)].parent, address("codex", 3));
  assert.equal(byAddress[address("claude", 1)].patternRun, "r1");
  assert.equal(byAddress[address("claude", 1)].name, "fixer");
  assert.equal(byAddress[address("cursor", 4)].worktree, "");
});
