import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadProjects } from "../lib/config.mjs";
import { addTask, ownTask, readStore, taskStoreFile, writeStore } from "../lib/tasks.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const OWNER = "claude#0123456789abcdef";

test("the UI state snapshot carries the task board and persists operator status moves", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-ui-tasks-");
  const root = path.join(home, "project");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = { HOME: home, PATH: process.env.PATH, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "first", title: "First task", status: "building" }, 1000);
  ownTask(doc, "first", OWNER, 1000);
  writeStore(taskStoreFile("demo", env), doc);

  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const post = (action, fields) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ project: "demo", ...fields }),
  }), action);
  assert.equal((await post("move-task", { id: "first", status: "ready" })).status, 400);
  assert.equal((await post("move-task", { id: "missing", status: "done" })).status, 400);
  assert.equal((await post("move-task", { id: "first", status: "done" })).status, 200);
  const response = await post("request-outcome", { outcome: "Improve signup", check: "Sign up on a phone" });
  assert.equal(response.status, 201);
  const { outcome } = await response.json();
  assert.equal((await post("approve-outcome", { id: outcome.id })).status, 409);
  const [stored] = readStore(taskStoreFile("demo", env)).tasks;
  assert.equal(stored.status, "done");
  assert.equal(stored.title, "First task");
  assert.equal(stored.owner, OWNER);
  const ctrl = new AbortController();
  try {
    const state = await firstUpdate(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })), "state");
    assert.equal(state.tasks.error, undefined);
    assert.deepEqual(state.tasks.outcomes, [outcome]);
    assert.equal(state.tasks.tasks.length, 1);
    assert.deepEqual([state.tasks.tasks[0].id, state.tasks.tasks[0].status, state.tasks.tasks[0].owner, state.tasks.tasks[0].ownerOnline], ["first", "done", OWNER, false]);
  } finally {
    ctrl.abort();
  }
});
