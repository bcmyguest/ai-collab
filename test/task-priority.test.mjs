import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import {
  addTask, createFileBackend, importFeatureRequests, openTasks, priorityOf, readStore, renderFeatureRequests,
  setTaskField, sortTasks, taskStoreFile, TASK_PRIORITIES, validateTasks, writeStore,
} from "../lib/tasks.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { COLUMNS, columnsOf, statusLabel } from "../web/lib/task-board.js";
import { tempDir } from "./helpers/tmp.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const LABEL = "aabbccddeeff0123";

function task(fields) {
  return { id: "a", title: "A", status: "open", blockers: [], progress: [], created: NOW, updated: NOW, ...fields };
}

function project() {
  const home = tempDir({ after }, "ai-collab-task-priority-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_PROJECT: "demo",
    AI_COLLAB_PEER: "claude", AI_COLLAB_STATE_DIR: path.join(home, "state"),
  };
  const out = [];
  const err = [];
  const cli = (...argv) => {
    out.length = 0;
    err.length = 0;
    return runCli(["task", ...argv], { env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } })
      .then((code) => ({ code, out: out.join(""), err: err.join("") }));
  };
  return { root, env, store: taskStoreFile("demo", env), cli };
}

test("priority is one of P0..P3 and a missing priority means P2", () => {
  assert.deepEqual(TASK_PRIORITIES, ["P0", "P1", "P2", "P3"]);
  assert.doesNotThrow(() => validateTasks({ v: 1, tasks: [task({})] }));
  for (const priority of TASK_PRIORITIES) assert.equal(validateTasks({ v: 1, tasks: [task({ priority })] }).tasks[0].priority, priority);
  for (const bad of ["P4", "p1", "", "high", 1, null]) {
    assert.throws(() => validateTasks({ v: 1, tasks: [task({ priority: bad })] }), /task a: invalid priority/);
  }
  assert.equal(priorityOf(task({})), "P2");
  assert.equal(priorityOf(task({ priority: "P0" })), "P0");
});

test("addTask stores an explicit priority and setTaskField validates it", () => {
  const doc = { v: 1, tasks: [] };
  addTask(doc, { title: "Urgent", priority: "P0" }, NOW);
  addTask(doc, { title: "Plain" }, NOW);
  assert.deepEqual(doc.tasks.map((t) => t.priority), ["P0", undefined]);
  setTaskField(doc, "plain", "priority", "P3", NOW + 1);
  assert.deepEqual([doc.tasks[1].priority, doc.tasks[1].updated], ["P3", NOW + 1]);
  assert.throws(() => setTaskField(doc, "plain", "priority", "P9", NOW), /invalid priority P9/);
  // A failed set leaves the field alone.
  assert.equal(doc.tasks[1].priority, "P3");
  assert.throws(() => addTask(doc, { title: "Bad", priority: "urgent" }, NOW), /invalid priority/);
});

test("the sort is priority, then status (building, blocked, open/decided, done), then newest first", () => {
  const tasks = [
    task({ id: "p2-done", status: "done", updated: 9 }),
    task({ id: "p1-done", priority: "P1", status: "done", updated: 9 }),
    task({ id: "p2-open-old", status: "open", updated: 1 }),
    task({ id: "p2-open-new", status: "open", updated: 5 }),
    task({ id: "p3-open", priority: "P3", status: "open", updated: 9 }),
    task({ id: "p2-building", status: "building", updated: 1 }),
    task({ id: "p0-blocked", priority: "P0", status: "blocked", updated: 1 }),
    task({ id: "p0-building", priority: "P0", status: "building", updated: 1 }),
  ];
  assert.deepEqual(sortTasks(tasks).map((t) => t.id), [
    "p0-building", "p0-blocked", "p1-done", "p2-building", "p2-open-new", "p2-open-old", "p2-done", "p3-open",
  ]);
  // open and decided share a rank; the newer one comes first.
  const queued = [task({ id: "decided", status: "decided", updated: 9 }), task({ id: "open", status: "open", updated: 1 })];
  assert.deepEqual(sortTasks(queued).map((t) => t.id), ["decided", "open"]);
  // The input is not reordered.
  assert.equal(tasks[0].id, "p2-done");
});

test("task CLI adds with --priority, sets priority, and lists sorted with the priority column", async () => {
  const { store, cli } = project();
  assert.equal((await cli("add", "Low", "--priority", "P3")).out, "low\n");
  assert.equal((await cli("add", "High")).out, "high\n");
  assert.equal((await cli("add", "Top")).out, "top\n");
  assert.equal((await cli("set", "top", "priority=P0")).code, 0);
  assert.equal((await cli("add", "Bad", "--priority", "P9")).code, 1);
  assert.equal((await cli("add", "--priority")).code, 1);
  assert.deepEqual(readStore(store).tasks.map((t) => [t.id, t.priority]), [["low", "P3"], ["high", undefined], ["top", "P0"]]);
  // Every non-P0 task is P2 here, so the order is priority first and then the column order.
  assert.equal((await cli("list")).out, "top\topen\tP0\t-\t-\tTop\nhigh\topen\tP2\t-\t-\tHigh\nlow\topen\tP3\t-\t-\tLow\n");
  assert.equal((await cli("list", "open")).out.split("\n")[0], "top\topen\tP0\t-\t-\tTop");
  assert.equal(JSON.parse((await cli("show", "top")).out).priority, "P0");
});

test("the MCP task_update takes priority and task_list sorts by it", { timeout: 15000 }, async (t) => {
  const fake = await startFakeNtfy();
  const home = tempDir(t, "ai-collab-mcp-priority-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, "config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = { ...peerEnv(fake, { peer: "claude", stateDir: path.join(home, "state") }), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), HOME: home };
  const store = taskStoreFile("demo", env);
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha", status: "open" }, 1);
  addTask(doc, { id: "beta", title: "Beta", status: "open" }, 2);
  writeStore(store, doc);

  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function call(name, args) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return JSON.parse((await output.next()).value).result;
  }
  const json = (result) => JSON.parse(result.content[0].text);

  assert.deepEqual(json(await call("task_list", { session: LABEL })).tasks.map((task) => [task.id, task.priority]), [["beta", "P2"], ["alpha", "P2"]]);
  const updated = json(await call("task_update", { id: "alpha", priority: "P0", session: LABEL }));
  assert.equal(updated.task.priority, "P0");
  assert.equal(createFileBackend(store).get("alpha").priority, "P0");
  assert.deepEqual(json(await call("task_list", { session: LABEL })).tasks.map((task) => task.id), ["alpha", "beta"]);
  const refused = await call("task_update", { id: "beta", priority: "P9", session: LABEL });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /invalid priority/);
  assert.equal(createFileBackend(store).get("beta").priority, undefined);
});

test("render adds a Priority column and sorts by it; import reads it back", () => {
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "low", title: "Low", status: "open", priority: "P3" }, NOW);
  addTask(doc, { id: "high", title: "High", status: "open", priority: "P0" }, NOW);
  addTask(doc, { id: "plain", title: "Plain", status: "building" }, NOW);
  const out = renderFeatureRequests(doc, "");
  const rows = out.split("\n").filter((line) => line.startsWith("|"));
  assert.deepEqual(rows.slice(0, 2), ["| Request | Priority | Status |", "|---|---|---|"]);
  assert.deepEqual(rows.slice(2), ["| High | P0 | open |", "| Plain | P2 | building |", "| Low | P3 | open |"]);
  // A missing priority round-trips as the default and the render is a fixed point.
  const back = importFeatureRequests(out, NOW);
  assert.deepEqual(back.tasks.map((t) => [t.title, priorityOf(t), t.status]), [["High", "P0", "open"], ["Plain", "P2", "building"], ["Low", "P3", "open"]]);
  assert.equal(renderFeatureRequests(back, out), out);
  // The old two-cell table still imports, with the default priority.
  const old = "# Feature requests\n\n<!-- tasks:start -->\n| Request | Status |\n|---|---|\n| Legacy | decided |\n<!-- tasks:end -->\n";
  const legacy = importFeatureRequests(old, NOW);
  assert.deepEqual([legacy.tasks[0].title, legacy.tasks[0].status, priorityOf(legacy.tasks[0])], ["Legacy", "decided", "P2"]);
});

test("the board sorts each column by priority and labels decided as Ready", () => {
  const tasks = [
    { id: "p3", status: "open", priority: "P3" },
    { id: "p0", status: "open", priority: "P0" },
    { id: "plain", status: "open" },
    { id: "ready", status: "decided", priority: "P1" },
  ];
  const columns = columnsOf(tasks);
  assert.deepEqual(columns.map(([status]) => status), COLUMNS);
  assert.deepEqual(columns[0][1].map((task) => task.id), ["p0", "plain", "p3"]);
  assert.deepEqual(columns[1][1].map((task) => task.id), ["ready"]);
  assert.equal(statusLabel("decided"), "Ready");
  assert.equal(statusLabel("open"), "open");
});

test("a store written before priorities loads and lists as P2", async () => {
  const { env, store, cli } = project();
  mkdirSync(path.dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify({ v: 1, tasks: [task({ id: "old", title: "Old" })] }));
  assert.equal(readStore(store).tasks[0].priority, undefined);
  assert.deepEqual(openTasks("demo", env).list().map(priorityOf), ["P2"]);
  assert.equal((await cli("list")).out, "old\topen\tP2\t-\t-\tOld\n");
});

test("the CLI help names the priority flag and the priority field", () => {
  const cli = readFileSync(fileURLToPath(new URL("../lib/cli.mjs", import.meta.url)), "utf8");
  assert.match(cli, /task add "<title>"\s+add an open task; --priority/);
  assert.match(cli, /task set <id> .*priority=/);
});
