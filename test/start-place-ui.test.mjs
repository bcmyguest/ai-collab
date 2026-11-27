import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects } from "../lib/config.ts";
import { createUi } from "../web/server/ui.mjs";
import { harnessPlaces, placeChoice } from "../web/lib/new-session.js";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const ID = "44444444-2222-4333-8444-555555555555";
const FAKE = (name) => `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_RECORD + "/${name}.jsonl", JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
console.log("Started background session ${ID}");
`;

// A project with a git repo, fake claude/cursor-agent/openshell/git on PATH, a runner socket file and a recording runner client.
async function setup(t, { defaults, socket = true } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-place-ui-");
  const bin = path.join(home, "bin");
  const root = path.join(home, "project");
  const record = path.join(home, "record");
  const runtime = path.join(home, "run");
  for (const dir of [bin, root, record, path.join(root, ".git"), path.join(home, ".config", "ai-collab"), path.join(runtime, "ai-collab")]) mkdirSync(dir, { recursive: true });
  for (const name of ["claude", "cursor-agent", "openshell", "git"]) {
    writeFileSync(path.join(bin, name), FAKE(name));
    chmodSync(path.join(bin, name), 0o755);
  }
  if (socket) writeFileSync(path.join(runtime, "ai-collab", "runner.sock"), "");
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,cursor" }]));
  if (defaults) writeFileSync(path.join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify(defaults));
  const env = { HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath), FAKE_RECORD: record, XDG_RUNTIME_DIR: runtime, AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const starts = [];
  const runner = () => ({ start: async (input) => { starts.push(input); return { status: 201, body: { status: "started", session: "cursor#0123456789abcdef" } }; } });
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env, runner });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "start");
  const state = async () => {
    const ctrl = new AbortController();
    try { return await firstUpdate(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })), "state"); } finally { ctrl.abort(); }
  };
  return { post, state, starts, record };
}

async function recorded(record, name) {
  for (let i = 0; i < 200; i++) {
    const file = path.join(record, name + ".jsonl");
    if (existsSync(file)) return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await delay(20);
  }
  throw new Error("fake " + name + " never ran");
}

test("with a runner and openshell, the snapshot offers openshell, names it the start place, and lists cursor as able", async (t) => {
  const snapshot = await (await setup(t)).state();
  assert.deepEqual(snapshot.startPlaces, ["folder", "worktree", "openshell"]);
  assert.equal(snapshot.startPlace, "openshell");
  assert.deepEqual(snapshot.openshellHarnesses, ["cursor"]);
  const none = await (await setup(t, { socket: false })).state();
  assert.deepEqual([none.startPlaces, none.startPlace, none.openshellHarnesses], [["folder", "worktree"], "folder", []]);
  assert.equal((await (await setup(t, { defaults: { startPlace: "worktree" } })).state()).startPlace, "worktree");
});

test("a cursor start with no place goes to the runner in openshell; nothing runs on the host", async (t) => {
  const { post, starts, record } = await setup(t);
  const result = await (await post({ project: "demo", harness: "cursor", prompt: "fix it", model: undefined })).json();
  assert.equal(result.status, "started");
  assert.deepEqual(starts, [{ project: "demo", harness: "cursor", prompt: "fix it", place: "openshell", system: false }]);
  assert.equal(existsSync(path.join(record, "cursor-agent.jsonl")), false);
});

test("a claude start with no place falls back to the folder; an explicit openshell for it is refused", async (t) => {
  const { post, starts, record } = await setup(t);
  const refused = await post({ project: "demo", harness: "claude", prompt: "x", place: "openshell" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /claude cannot start in OpenShell yet/);
  const started = await (await post({ project: "demo", harness: "claude", prompt: "fix it" })).json();
  assert.equal(started.status, "started");
  assert.deepEqual((await recorded(record, "claude"))[0].argv, ["--bg", "--permission-mode", "default", "fix it"]);
  assert.deepEqual(starts, []);
});

test("an explicit folder start stays on the host even when openshell is the start place", async (t) => {
  const { post, starts, record } = await setup(t);
  await (await post({ project: "demo", harness: "cursor", prompt: "local", place: "folder" })).json();
  assert.equal((await recorded(record, "cursor-agent")).length, 1);
  assert.deepEqual(starts, []);
});

test("the composer's place pill offers openshell only to able harnesses and preselects the start place", () => {
  const places = ["folder", "worktree", "openshell"];
  assert.deepEqual(harnessPlaces(places, "claude", ["cursor"]), ["folder", "worktree"]);
  assert.deepEqual(harnessPlaces(places, "cursor", ["cursor"]), places);
  assert.equal(placeChoice("", places, "openshell"), "openshell");
  assert.equal(placeChoice("", ["folder", "worktree"], "openshell"), "folder");
  assert.equal(placeChoice("worktree", places, "openshell"), "worktree");
  assert.equal(placeChoice("openshell", ["folder"], "openshell"), "folder");
  assert.equal(placeChoice("", ["worktree"], "openshell"), "worktree");
});
