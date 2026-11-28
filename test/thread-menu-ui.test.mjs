// The sidebar row menu's ops through POST /api/thread (docs/threads.md "Sidebar"): rename, pin, status, the bulk archive,
// archived threads kept in the snapshot, and each thread's place ("main" or its worktree folder).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { projectThreads } from "../web/server/threads.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const ID = (n) => "th_" + String(n).padStart(16, "0");

/** A thread store in memory that records each update and honours the archived flag of list. */
function recordingThreads(threads) {
  const calls = [];
  const find = (id) => threads.find((t) => t.id === id);
  return {
    calls,
    list: async (project, { archived = false } = {}) => { calls.push(["list", archived]); return threads.filter((t) => archived || t.status !== "archived"); },
    get: async (id) => find(id),
    update: async (id, fields) => { calls.push(["update", id, fields]); Object.assign(find(id), fields, fields.title ? { titleSource: "operator" } : {}); return find(id); },
    sync: async (input) => { calls.push(["sync", input.sessions.map((s) => s.address).sort()]); return { assigned: [], created: 0 }; },
    create: async () => threads[0], moveSession: async (id) => find(id), attachPr: async (id) => find(id), detachPr: async (id) => find(id),
  };
}

test("the row menu's ops reach the store, archived threads stay listed, and each thread says where it runs", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const root = tempDir(t, "ai-collab-menu-ui-");
  const xdg = tempDir(t, "ai-collab-xdg-");
  const env = { ...peerEnv(fake, { peer: "alice" }), XDG_CONFIG_HOME: xdg };
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  writeFileSync(path.join(xdg, "ai-collab", "projects.json"), JSON.stringify([{ project: "demo", root }]));
  const tree = path.join(root, ".claude", "worktrees", "wt-menu");
  const store = recordingThreads([
    { id: ID(1), project: "demo", title: "Main work", worktree: root, branch: "main", status: "active", sessions: [] },
    { id: ID(2), project: "demo", title: "Worktree work", worktree: tree, branch: "feat/menu", status: "active", sessions: [] },
    { id: ID(3), project: "demo", title: "Old", worktree: tree, status: "archived", sessions: [] },
  ]);
  const cfg = loadConfig(env);
  const ui = createUi({ cfg, env, threadClient: () => store });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/thread`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", ...body }),
  }), "thread");
  async function snapshot() {
    const ctrl = new AbortController();
    const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
    const first = (await stream.next()).value;
    ctrl.abort();
    return first.data;
  }

  assert.equal((await post({ op: "rename", thread: ID(1), title: "Renamed" })).status, 200);
  assert.equal((await post({ op: "pin", thread: ID(2), pinned: true })).status, 200);
  for (const status of ["settled", "snoozed", "active"]) assert.equal((await post({ op: "status", thread: ID(2), status })).status, 200);
  assert.equal((await post({ op: "status", thread: ID(3), status: "active" })).status, 200, "Unarchive");
  assert.equal((await post({ op: "archive", threads: [ID(1), ID(3)] })).status, 200);
  assert.equal((await post({ op: "archive", threads: [] })).status, 400);
  assert.deepEqual(store.calls.filter(([kind]) => kind === "update").map(([, id, fields]) => [id, fields]), [
    [ID(1), { title: "Renamed" }], [ID(2), { pinned: true }], [ID(2), { status: "settled" }], [ID(2), { status: "snoozed" }],
    [ID(2), { status: "active" }], [ID(3), { status: "active" }], [ID(1), { status: "archived" }], [ID(3), { status: "archived" }],
  ]);
  assert.ok(store.calls.filter(([kind]) => kind === "list").every(([, archived]) => archived), "the snapshot lists archived threads too");

  const threads = (await snapshot()).threads;
  assert.deepEqual(threads.map((t) => [t.id, t.title, t.status, t.place]), [
    [ID(1), "Renamed", "archived", "main"], [ID(2), "Worktree work", "active", "wt-menu"], [ID(3), "Old", "archived", "wt-menu"],
  ]);
});

test("sync posts a known lead again when its thread's title would change, and stops after a rename", async (t) => {
  const stateDir = tempDir(t, "ai-collab-thread-retitle-");
  const registry = path.join(stateDir, "demo", "registry");
  mkdirSync(registry, { recursive: true });
  const lead = "claude#" + sessionLabel("lead-1");
  const record = (fields) => writeFileSync(path.join(registry, lead + ".json"), JSON.stringify({ id: lead, sessionId: "lead-1", cwd: "/repo/demo", harness: "claude", ...fields }));
  record({ activity: "Old activity", identityName: "Lead" });
  const store = recordingThreads([{ id: ID(1), project: "demo", title: "Old activity", titleSource: "auto", worktree: "/repo/demo", status: "active", sessions: [lead] }]);
  const prompts = new Map();
  const threads = projectThreads({ project: "demo", stateDir, peers: [], root: "/repo/demo" }, { env: { HOME: stateDir }, client: store, delayMs: 0, prompts: () => prompts });
  const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
  const syncs = () => store.calls.filter(([kind]) => kind === "sync").map(([, sessions]) => sessions);
  await threads.refresh();
  threads.sync();
  await settled();
  assert.deepEqual(syncs(), [], "an unchanged title posts nothing");
  record({ activity: "New activity", identityName: "Lead" });
  threads.sync();
  await settled();
  assert.deepEqual(syncs(), [[lead]]);
  await threads.handle({ op: "rename", thread: ID(1), title: "Mine" });
  record({ activity: "Newer activity", identityName: "Lead" });
  threads.sync();
  await settled();
  assert.deepEqual(syncs(), [[lead]], "an operator rename stops the posts");
  threads.close();
});
