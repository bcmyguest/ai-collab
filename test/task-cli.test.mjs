import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../lib/cli.mjs";
import { readStore, taskStoreFile } from "../lib/tasks.mjs";

const SESSION = "0123456789abcdef";

function project({ session } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-task-cli-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), ...(session ? { AI_COLLAB_SESSION: session } : {}),
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

test("task CLI adds, sets, blocks, owns and records progress in the store", async () => {
  const { store, cli } = project({ session: SESSION });
  assert.deepEqual(await cli("add", "Scratch", "probe"), { code: 0, out: "scratch-probe\n", err: "" });
  assert.equal((await cli("set", "scratch-probe", "status=building", "detail=in flight")).code, 0);
  assert.equal((await cli("add", "Second")).out, "second\n");
  assert.equal((await cli("block", "scratch-probe", "second")).code, 0);
  assert.equal((await cli("own", "scratch-probe", `claude#${SESSION}`)).code, 0);
  assert.equal((await cli("set", "scratch-probe", "run=lx9k2mabc123")).code, 0);
  assert.equal((await cli("progress", "scratch-probe", "tests", "green")).code, 0);

  const task = readStore(store).tasks.find((t) => t.id === "scratch-probe");
  assert.equal(task.title, "Scratch probe");
  assert.deepEqual([task.status, task.detail, task.blockers, task.owner, task.run], ["building", "in flight", ["second"], `claude#${SESSION}`, "lx9k2mabc123"]);
  assert.deepEqual(task.progress.map(({ by, text }) => [by, text]), [[`claude#${SESSION}`, "tests green"]]);
});

test("task CLI rejects an invalid run id and reports a clipped progress note", async () => {
  const { cli } = project();
  await cli("add", "Alpha");
  assert.equal((await cli("set", "alpha", "run=lx9k2m-abc123")).code, 1);
  const long = await cli("progress", "alpha", "x".repeat(600));
  assert.equal(long.code, 0);
  assert.match(long.out, /clipped to 500 characters/);
});

test("task CLI list filters by status and show prints one task", async () => {
  const { cli } = project();
  await cli("add", "Alpha");
  await cli("add", "Beta");
  await cli("set", "beta", "status=done");
  assert.equal((await cli("list")).out, "alpha\topen\tP2\t-\t-\tAlpha\nbeta\tdone\tP2\t-\t-\tBeta\n");
  assert.equal((await cli("list", "done")).out, "beta\tdone\tP2\t-\t-\tBeta\n");
  const shown = await cli("show", "beta");
  assert.equal(JSON.parse(shown.out).status, "done");
  assert.equal((await cli("show", "missing")).code, 1);
});

test("task CLI rejects bad input and leaves the store unchanged", async () => {
  const { store, cli } = project();
  await cli("add", "Alpha");
  const before = readFileSync(store, "utf8");
  const bad = [
    ["set", "alpha", "status=started"],
    ["set", "alpha", "created=1"],
    ["own", "alpha", "not-an-address"],
    ["block", "alpha", "alpha"],
    ["set", "missing", "status=done"],
    ["list", "started"],
  ];
  for (const argv of bad) {
    const result = await cli(...argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.err, /^ai-collab: /);
  }
  assert.equal(readFileSync(store, "utf8"), before);
  const unknown = await cli("bogus");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /usage: task list/);
});

test("task CLI renders feature-requests.md, imports once, and imports a store file", async () => {
  const { root, env, store, cli } = project();
  const table = path.join(root, "..", "table.md");
  writeFileSync(table, "| Request | Status |\n|---|---|\n| Ship it | done (merged) |\n| Plan it | decided |\n");
  assert.equal((await cli("import", table)).out, "imported 2 tasks\n");
  assert.equal((await cli("import", table)).code, 1);
  assert.equal((await cli("render")).code, 0);
  const rendered = readFileSync(path.join(root, "docs", "feature-requests.md"), "utf8");
  assert.ok(rendered.includes("| Ship it | P2 | done (merged) |"));
  assert.ok(rendered.includes("| Plan it | P2 | decided |"));

  // A .json store file (the old .ai-collab/tasks.json shape) imports too, into a new project store.
  const json = path.join(root, "..", "tasks.json");
  writeFileSync(json, JSON.stringify({ v: 1, tasks: [{ id: "old", title: "Old", status: "open", blockers: [], progress: [], created: 1, updated: 1 }] }));
  const second = project();
  assert.equal((await second.cli("import", json)).out, "imported 1 tasks\n");
  assert.equal(readStore(second.store).tasks[0].id, "old");
  assert.equal(store.endsWith("demo.json"), true);
  assert.equal(env.XDG_DATA_HOME.endsWith("data"), true);
});

test("task add --help prints usage instead of adding a task called --help", async () => {
  const { store, cli } = project();
  const help = await cli("add", "--help");
  assert.equal(help.code, 0);
  assert.match(help.out, /usage: task add "<title>"/);
  assert.equal(help.err, "");
  assert.equal(readStore(store).tasks.length, 0);

  // A bare task --help, task help and any other subcommand with --help all print usage and add nothing.
  for (const argv of [["--help"], ["help"], ["set", "--help"], ["remove", "-h"]]) {
    const result = await cli(...argv);
    assert.equal(result.code, 0, argv.join(" "));
    assert.match(result.out, /usage: task /, argv.join(" "));
  }
  assert.equal(readStore(store).tasks.length, 0);

  // --help among real words is still help: it never reaches a title.
  const mixed = await cli("add", "Fix", "--help");
  assert.equal(mixed.code, 0);
  assert.match(mixed.out, /usage: task add/);
  assert.equal(readStore(store).tasks.length, 0);

  // An unknown subcommand with --help still fails.
  assert.equal((await cli("bogus", "--help")).code, 1);
});

test("task remove deletes a task and refuses one another task is blocked on", async () => {
  const { store, cli } = project();
  await cli("add", "Alpha");
  await cli("add", "Beta");
  await cli("block", "beta", "alpha");

  const blocked = await cli("remove", "alpha");
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /blocked on by beta/);
  assert.deepEqual(readStore(store).tasks.map((t) => t.id), ["alpha", "beta"]);

  assert.deepEqual(await cli("remove", "beta"), { code: 0, out: "beta removed\n", err: "" });
  assert.deepEqual(await cli("remove", "alpha"), { code: 0, out: "alpha removed\n", err: "" });
  assert.deepEqual(readStore(store).tasks, []);

  const missing = await cli("remove", "alpha");
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no task alpha/);
  assert.equal((await cli("remove")).code, 1);
  assert.equal((await cli("remove", "a", "b")).code, 1);
});
