import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProjects } from "../lib/config.mjs";
import { addTask, ownTask, writeTasks } from "../lib/tasks.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const OWNER = "claude#0123456789abcdef";

test("the UI state snapshot carries the project's task board", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-ui-tasks-"));
  const root = path.join(home, "project");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "first", title: "First task", status: "building" }, 1000);
  ownTask(doc, "first", OWNER, 1000);
  writeTasks(root, doc);

  const env = { HOME: home, PATH: process.env.PATH, AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const ctrl = new AbortController();
  try {
    const state = await firstUpdate(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })), "state");
    assert.equal(state.tasks.error, undefined);
    assert.equal(state.tasks.tasks.length, 1);
    assert.deepEqual([state.tasks.tasks[0].id, state.tasks.tasks[0].status, state.tasks.tasks[0].owner, state.tasks.tasks[0].ownerOnline], ["first", "building", OWNER, false]);
  } finally {
    ctrl.abort();
  }
});
