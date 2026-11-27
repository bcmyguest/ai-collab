// The thread status the sidebar shows (docs/threads.md "Status"), and the UI server's thread cache, sync and start claim.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { threadRows, threadStatus } from "../web/lib/threads.js";
import { projectThreads, promptTitle } from "../web/server/threads.mjs";
import { sessionLabel } from "../lib/config.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const NOW = 1_800_000_000_000;
const idle = { id: "codex#0000000000000001", online: true };
const working = { id: "claude#0000000000000002", online: true, lastActivityAt: NOW - 1000 };
const waiting = { id: "cursor#0000000000000003", online: true, pending: [{ blocking: true }] };
const held = { id: "claude#0000000000000004", online: true, afkHold: true };

test("threadStatus: waiting beats working beats the stored status", () => {
  assert.equal(threadStatus("snoozed", [idle, working, waiting], NOW), "waiting");
  assert.equal(threadStatus("active", [held], NOW), "waiting");
  assert.equal(threadStatus("settled", [idle, working], NOW), "working");
  assert.equal(threadStatus("settled", [idle], NOW), "settled");
  assert.equal(threadStatus(undefined, [], NOW), "active");
});

test("threadRows nests the listed session cards and drops archived threads unless one waits", () => {
  const rows = threadRows([
    { id: "th_a", status: "active", sessions: [idle.id, "gone#0000000000000009"] },
    { id: "th_b", status: "archived", sessions: [idle.id] },
    { id: "th_c", status: "archived", sessions: [waiting.id] },
  ], [idle, waiting], NOW);
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.agents.map((agent) => agent.id)]), [
    ["th_a", "active", [idle.id]],
    ["th_c", "waiting", [waiting.id]],
  ]);
});

/** A thread client in memory: records calls, keeps threads in a map. */
function fakeClient() {
  const threads = new Map();
  const calls = [];
  let n = 0;
  const client = {
    calls,
    list: async () => [...threads.values()],
    get: async (id) => threads.get(id) || Promise.reject(Object.assign(new Error("Unknown thread"), { status: 404 })),
    create: async (fields) => {
      calls.push(["create", fields]);
      const id = `th_${String(++n).padStart(16, "0")}`;
      threads.set(id, { id, sessions: [], status: "active", ...fields });
      return threads.get(id);
    },
    moveSession: async (id, session) => {
      calls.push(["move", id, session]);
      threads.get(id).sessions.push(session);
      return threads.get(id);
    },
    sync: async (input) => {
      calls.push(["sync", input.sessions.map((s) => s.address)]);
      return { assigned: [], created: 0 };
    },
  };
  return client;
}

test("a start claims a new thread titled from the prompt, or joins the thread it names", async (t) => {
  const client = fakeClient();
  const cfg = { project: "demo", stateDir: tempDir(t, "ai-collab-thread-ui-"), peers: [] };
  const threads = projectThreads(cfg, { env: { HOME: cfg.stateDir }, client });
  const fresh = await threads.claim("codex#0000000000000001", { prompt: "Fix the   flaky\nbus test today please, it fails on CI often" });
  assert.equal(fresh.sessions[0], "codex#0000000000000001");
  assert.deepEqual(client.calls[0], ["create", { project: "demo", title: "Fix the flaky bus test today please, it" }]);
  await threads.claim("claude#0000000000000002", { thread: fresh, prompt: "more" });
  assert.deepEqual(client.calls.at(-1), ["move", fresh.id, "claude#0000000000000002"]);
  assert.equal(threads.list().length, 1);
  assert.equal(await threads.claim(undefined, { prompt: "no session id yet" }), null);
  assert.equal(promptTitle(""), "");
});

test("sync posts sessions no thread lists yet, and those of a thread still without a worktree", async (t) => {
  const client = fakeClient();
  const stateDir = tempDir(t, "ai-collab-thread-sync-");
  const registry = path.join(stateDir, "demo", "registry");
  mkdirSync(registry, { recursive: true });
  const ids = ["s-1", "s-2"].map((sessionId, i) => ({ id: `${["codex", "claude"][i]}#${sessionLabel(sessionId)}`, sessionId }));
  for (const { id, sessionId } of ids) {
    writeFileSync(path.join(registry, `${id}.json`), JSON.stringify({ id, sessionId, cwd: "/repo/demo", harness: id.split("#")[0] }));
  }
  const threads = projectThreads({ project: "demo", stateDir, peers: [] }, { env: { HOME: stateDir }, client, delayMs: 0 });
  const claimed = await threads.claim(ids[0].id, { prompt: "known" });
  const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
  threads.sync();
  await settled();
  claimed.worktree = "/repo/demo";
  await threads.refresh();
  threads.sync();
  await settled();
  const synced = client.calls.filter(([kind]) => kind === "sync").map(([, sessions]) => sessions.sort());
  assert.deepEqual(synced, [[ids[0].id, ids[1].id].sort(), [ids[1].id]]);
});
