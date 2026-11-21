import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects, sessionLabel } from "../lib/config.mjs";
import { startCommand, worktreeNames } from "../lib/start.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const ID = "44444444-2222-4333-8444-555555555555";
// Fake executable: records argv and cwd, makes the worktree dir git would make, and prints a Codex/Claude id line.
const FAKE = (name) => `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RECORD + "/${name}.jsonl", JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
if ("${name}" === "git") { fs.mkdirSync(argv.at(-1), { recursive: true }); process.exit(Number(process.env.FAKE_GIT_EXIT || 0)); }
console.log(argv.includes("exec") && argv.includes("--json") ? JSON.stringify({ type: "thread.started", thread_id: "${ID}" }) : "Started background session ${ID}");
`;

async function setup(t, { sandbox = "dev-box", git = true, gitExit = 0 } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-places-"));
  const bin = path.join(home, "bin");
  const root = path.join(home, "project");
  const record = path.join(home, "record");
  for (const dir of [bin, root, record, path.join(root, ".git"), path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  for (const name of ["claude", "codex", "openshell", ...(git ? ["git"] : [])]) {
    writeFileSync(path.join(bin, name), FAKE(name));
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex" }]));
  // PATH holds only the fakes and node's own directory, so a real git or openshell is never found.
  const env = {
    HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath), FAKE_RECORD: record, FAKE_GIT_EXIT: String(gitExit), CODEX_HOME: path.join(home, ".codex"),
    AI_COLLAB_STATE_DIR: path.join(home, "state"), ...(sandbox ? { AI_COLLAB_OPENSHELL_SANDBOX: sandbox } : {}),
  };
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "start");
  const state = async () => {
    const ctrl = new AbortController();
    const reader = ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })).body.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!/event: state\ndata: (.*)\n\n/.test(text)) text += (await reader.read()).value;
    ctrl.abort();
    return JSON.parse(/event: state\ndata: (.*)\n\n/.exec(text)[1]);
  };
  return { post, root, record, state };
}

async function recorded(record, name, count = 1) {
  for (let i = 0; i < 200; i++) {
    const file = path.join(record, name + ".jsonl");
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (lines.length >= count) return lines;
    }
    await delay(20);
  }
  throw new Error("fake " + name + " never ran");
}

test("worktree names and Claude's own --worktree argv", () => {
  assert.deepEqual(worktreeNames("codex", Date.UTC(2026, 10, 21, 17, 1, 2, 345)), { name: "ai-collab-codex-20261121T170102Z", branch: "ai-collab/codex-20261121T170102Z" });
  assert.deepEqual(startCommand("claude", "/r", "hi", { worktree: "ai-collab-claude-x" }), ["claude", ["--bg", "--worktree", "ai-collab-claude-x", "hi"]]);
});

test("the snapshot offers folder, worktree and openshell only when each is usable", async (t) => {
  assert.deepEqual((await (await setup(t)).state()).startPlaces, ["folder", "worktree", "openshell"]);
  assert.deepEqual((await (await setup(t, { sandbox: "", git: false })).state()).startPlaces, ["folder"]);
  assert.deepEqual((await (await setup(t, { sandbox: "bad name;rm" })).state()).startPlaces, ["folder", "worktree"]);
});

test("worktree start: Claude gets --worktree; Codex starts in a git worktree on an ai-collab branch", async (t) => {
  const { post, root, record } = await setup(t);
  const claude = await (await post({ project: "demo", harness: "claude", prompt: "fix it", place: "worktree" })).json();
  assert.equal(claude.status, "started");
  assert.equal(claude.session, "claude#" + sessionLabel(ID));
  const [run] = await recorded(record, "claude");
  assert.deepEqual(run.argv.slice(0, 2), ["--bg", "--worktree"]);
  assert.match(run.argv[2], /^ai-collab-claude-\d{8}T\d{6}Z$/);
  assert.equal(run.argv[3], "fix it");
  assert.equal(run.cwd, root);
  assert.equal(existsSync(path.join(record, "git.jsonl")), false, "Claude makes its own worktree");

  const second = await setup(t);
  const codex = await (await second.post({ project: "demo", harness: "codex", prompt: "add tests", place: "worktree" })).json();
  assert.equal(codex.status, "started");
  const [git] = await recorded(second.record, "git");
  const name = /ai-collab-codex-\d{8}T\d{6}Z/.exec(git.argv.at(-1))[0];
  const tree = path.join(second.root, ".claude", "worktrees", name);
  assert.deepEqual(git.argv, ["-C", second.root, "worktree", "add", "-b", "ai-collab/" + name.slice("ai-collab-".length), tree]);
  const [harness] = await recorded(second.record, "codex");
  assert.deepEqual(harness.argv, ["exec", "--json", "add tests"]);
  assert.equal(harness.cwd, tree);
  assert.match(codex.detail, new RegExp("worktree " + name));
});

test("a failed git worktree add starts nothing", async (t) => {
  const { post, record } = await setup(t, { gitExit: 128 });
  const result = await (await post({ project: "demo", harness: "codex", prompt: "x", place: "worktree" })).json();
  assert.deepEqual([result.status, result.detail], ["failed", "git worktree add exited 128"]);
  assert.equal(existsSync(path.join(record, "codex.jsonl")), false);
});

test("openshell start wraps the fixed argv in sandbox exec with the configured sandbox", async (t) => {
  const { post, root, record } = await setup(t);
  const result = await (await post({ project: "demo", harness: "claude", prompt: "$(touch x)", place: "openshell" })).json();
  assert.equal(result.status, "started");
  const [run] = await recorded(record, "openshell");
  assert.deepEqual(run.argv, ["sandbox", "exec", "--name", "dev-box", "--workdir", root, "--no-tty", "--no-login-shell", "--", "claude", "--bg", "$(touch x)"]);
  assert.equal(existsSync(path.join(record, "claude.jsonl")), false, "the harness runs inside the sandbox, not on the host");
});

test("the UI's worktree and openshell booleans pick the same places; both at once is rejected", async (t) => {
  const { post, record } = await setup(t);
  assert.equal((await post({ project: "demo", harness: "codex", prompt: "x", worktree: true, openshell: true })).status, 400);
  const result = await (await post({ project: "demo", harness: "codex", prompt: "x", worktree: true })).json();
  assert.equal(result.status, "started");
  assert.equal((await recorded(record, "git")).length, 1);
  const second = await setup(t);
  await (await second.post({ project: "demo", harness: "claude", prompt: "y", openshell: true })).json();
  assert.equal((await recorded(second.record, "openshell"))[0].argv[3], "dev-box");
});

test("an unavailable or unknown place is rejected server-side", async (t) => {
  const { post, record } = await setup(t, { sandbox: "" });
  assert.equal((await post({ project: "demo", harness: "codex", prompt: "x", place: "openshell" })).status, 400);
  assert.equal((await post({ project: "demo", harness: "codex", prompt: "x", place: "../tmp" })).status, 400);
  assert.equal((await post({ project: "demo", harness: "codex", prompt: "x", place: ["worktree"] })).status, 400);
  assert.equal(existsSync(path.join(record, "codex.jsonl")), false);
});
