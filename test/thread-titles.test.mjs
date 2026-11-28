// Thread naming (docs/threads.md "Naming"): the lead session's activity line, else its first prompt line, an operator
// rename that freezes the title, the placeholder backfill, and where a thread runs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { test, after } from "node:test";
import { openPostgresBusStore } from "../lib/bus-postgres.ts";
import { pgUrl } from "../lib/postgres.ts";
import { nextTitle, sessionTitle, threadPlace } from "../lib/threads.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const ROOT = "/repo/demo";
const TREE = `${ROOT}/.claude/worktrees/ai-collab-codex-1`;
const pgUp = await dbosTestDb();
const skip = !pgUp && "Postgres not reachable";
const address = (peer, n) => `${peer}#${String(n).padStart(16, "0")}`;

async function withStore(fn) {
  const { default: pg } = await import("pg");
  const schema = `bus_tt_${randomBytes(4).toString("hex")}`;
  const dir = tempDir({ after }, "ai-collab-titles-");
  const store = await openPostgresBusStore({ url: pgUrl(process.env), filesDir: path.join(dir, "files"), schema });
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    return await fn({ store, schema, query: async (sql, params) => (await pool.query(sql, params)).rows });
  } finally {
    await store.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
}

test("a session titles its thread with its activity line, else its first prompt line clipped to 60", () => {
  assert.equal(sessionTitle({ activity: "  Fix the   bus\nsecond", prompt: "ignored" }), "Fix the bus");
  assert.equal(sessionTitle({ prompt: "\n\n  Make the sidebar show worktrees  \nthen more" }), "Make the sidebar show worktrees");
  assert.equal(sessionTitle({ prompt: "x".repeat(90) }).length, 60);
  assert.equal(sessionTitle({}), "");
});

test("nextTitle follows an auto title, keeps an operator rename, and fixes only placeholders on rows from before title_source", () => {
  const lead = { activity: "Review PR 12", name: "reviewer" };
  assert.equal(nextTitle({ title: "old", titleSource: "auto", worktree: TREE }, lead, ROOT), "Review PR 12");
  assert.equal(nextTitle({ title: "Review PR 12", titleSource: "auto", worktree: TREE }, lead, ROOT), null);
  assert.equal(nextTitle({ title: "Mine", titleSource: "operator", worktree: TREE }, lead, ROOT), null);
  assert.equal(nextTitle({ title: "From a start", titleSource: null, worktree: ROOT }, lead, ROOT), null);
  assert.equal(nextTitle({ title: address("claude", 1), titleSource: null, worktree: ROOT }, lead, ROOT), "Review PR 12");
  assert.equal(nextTitle({ title: "ai-collab-codex-1", titleSource: null, worktree: TREE }, { prompt: "Ship it" }, ROOT), "Ship it");
  // Without a title of the session's own: its name, else the folder, else Untitled; never the address.
  assert.equal(nextTitle({ title: address("claude", 1), titleSource: null, worktree: ROOT }, { name: "planner" }, ROOT), "planner");
  assert.equal(nextTitle({ title: address("claude", 1), titleSource: null, worktree: ROOT }, { name: address("claude", 1) }, ROOT), "Untitled");
  assert.equal(nextTitle({ title: "ai-collab-codex-1", titleSource: "auto", worktree: TREE }, {}, ROOT), null);
  // An auto title the session no longer backs (its prompt left memory) stays.
  assert.equal(nextTitle({ title: "Ship it", titleSource: "auto", worktree: TREE }, { name: "planner" }, ROOT), null);
});

test("threadPlace names the main checkout main and a worktree by its folder", () => {
  assert.equal(threadPlace(ROOT, ROOT), "main");
  assert.equal(threadPlace(TREE, ROOT), "ai-collab-codex-1");
  assert.equal(threadPlace("", ROOT), "");
});

test("sync names new threads from the lead, follows its activity, and stops after a rename", { skip }, () => withStore(async ({ store }) => {
  const lead = address("claude", 1);
  const child = address("codex", 2);
  const loner = address("claude", 3);
  const sessions = [
    { address: lead, cwd: TREE, worktree: TREE, prompt: "Fix the flaky bus test\nit fails on CI" },
    { address: child, cwd: TREE, worktree: TREE, parent: lead, activity: "child work" },
    { address: loner, cwd: ROOT },
  ];
  await store.threads.sync({ project: "demo", root: ROOT, sessions });
  const byLead = async (s) => (await store.threads.list({ project: "demo" })).find((t) => t.sessions.includes(s));
  assert.equal((await byLead(lead)).title, "Fix the flaky bus test");
  assert.equal((await byLead(lead)).titleSource, "auto");
  assert.equal((await byLead(loner)).title, "Untitled", "a root session never titles its thread with its address");

  const before = await byLead(lead);
  const second = await store.threads.sync({ project: "demo", root: ROOT, sessions: [{ ...sessions[0], activity: "Rewrite the bus retry" }] });
  assert.equal(second.retitled, 1);
  const renamed = await byLead(lead);
  assert.equal(renamed.title, "Rewrite the bus retry");
  assert.equal(renamed.updatedAt, before.updatedAt, "naming is not work");

  await store.threads.update(renamed.id, { title: "Bus retry" });
  assert.equal((await byLead(lead)).titleSource, "operator");
  await store.threads.sync({ project: "demo", root: ROOT, sessions: [{ ...sessions[0], activity: "Something else" }] });
  assert.equal((await byLead(lead)).title, "Bus retry");
}));

test("rows from before title_source: placeholder titles get the lead's title, others stay", { skip }, () => withStore(async ({ store, schema, query }) => {
  const a = address("claude", 4);
  const b = address("claude", 5);
  await store.threads.sync({ project: "demo", root: ROOT, sessions: [{ address: a, cwd: ROOT }, { address: b, cwd: TREE, worktree: TREE }] });
  const [ta, tb] = await Promise.all([a, b].map(async (s) => (await store.threads.list({ project: "demo" })).find((t) => t.sessions.includes(s))));
  await query(`UPDATE ${schema}.threads SET title = $2, title_source = NULL WHERE id = $1`, [ta.id, a]);
  await query(`UPDATE ${schema}.threads SET title = 'Hand named', title_source = NULL WHERE id = $1`, [tb.id]);
  await store.threads.sync({ project: "demo", root: ROOT, sessions: [{ address: a, cwd: ROOT, activity: "Triage alerts" }, { address: b, cwd: TREE, worktree: TREE, activity: "Other" }] });
  const after = await store.threads.list({ project: "demo" });
  assert.deepEqual(after.filter((t) => [ta.id, tb.id].includes(t.id)).map((t) => [t.title, t.titleSource]).sort(), [["Hand named", null], ["Triage alerts", "auto"]]);
}));
