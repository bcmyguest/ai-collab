import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { READ_PATHS, classifyCall, isRefusal, isRunCodeFailure, journalSource, taskStoreSource } from "../lib/analyze-sources.mjs";

const home = () => mkdtempSync(join(tmpdir(), "as-"));
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

test("READ_PATHS lists the four read paths in order", () => {
  assert.deepEqual(READ_PATHS, ["mcp_read", "cli_read", "run_code", "run_read_code"]);
});

test("an ai-collab MCP read tool is mcp_read; run_code and run_read_code keep their own path", () => {
  assert.deepEqual(classifyCall({ name: "mcp__plugin_ai-collab_ai-collab__task_list" }), { path: "mcp_read", tool: "task_list" });
  assert.deepEqual(classifyCall({ name: "mcp__plugin_ai-collab_ai-collab-code__run_code" }), { path: "run_code", tool: "run_code" });
  assert.deepEqual(classifyCall({ name: "mcp__ai-collab-code__run_read_code" }), { path: "run_read_code", tool: "run_read_code" });
});

test("an ai-collab MCP write tool and a server-code tool outside the read set are not reads", () => {
  assert.equal(classifyCall({ name: "mcp__plugin_ai-collab_ai-collab__send" }).path, null);
  assert.equal(classifyCall({ name: "mcp__ai-collab-code__run_write" }).path, null);
});

test("a shell command that runs ai-collab read verbs is cli_read; other shell commands are not", () => {
  assert.equal(classifyCall({ name: "Bash", input: { command: "ai-collab task list" } }).path, "cli_read");
  assert.equal(classifyCall({ name: "Bash", input: { command: "ai-collab team status" } }).path, "cli_read");
  assert.equal(classifyCall({ name: "Bash", input: { command: "ai-collab task add foo" } }).path, null);
  assert.equal(classifyCall({ name: "Bash", input: { command: "ls -la" } }).path, null);
});

test("the loose matcher finds a read verb after a separator that strict parsing misses in a string input", () => {
  const cmd = "echo start && ai-collab status";
  assert.equal(classifyCall({ name: "Bash", input: cmd, loose: true }).path, "cli_read");
  assert.equal(classifyCall({ name: "Bash", input: cmd, loose: false }).path, "cli_read");
});

test("a string input passed as the command is read as the command", () => {
  assert.equal(classifyCall({ name: "Bash", input: "ai-collab sessions" }).path, "cli_read");
});

test("isRefusal matches the run_code redirect text and nothing else", () => {
  assert.equal(isRefusal("reads go through run_code"), true);
  assert.equal(isRefusal("use run_code instead, this call is refused through run_code"), true);
  assert.equal(isRefusal("ok"), false);
  assert.equal(isRefusal(null), false);
});

test("isRunCodeFailure: ok false, a staging error, or an error flag fails; a refusal never does", () => {
  assert.equal(isRunCodeFailure('{"ok": false}', false), true);
  assert.equal(isRunCodeFailure("could not stage the program", false), true);
  assert.equal(isRunCodeFailure("boom", true), true);
  assert.equal(isRunCodeFailure('{"ok": true}', false), false);
  assert.equal(isRunCodeFailure("reads go through run_code", true), false);
});

test("taskStoreSource reads every task file and counts each task's progress entries", async () => {
  const h = home();
  put(join(h, ".local/share/ai-collab/tasks/a.json"), JSON.stringify({ tasks: [
    { id: "t1", status: "done", updated: 10, created: 1, progress: [{}, {}] },
    { id: "t2", status: "open", updated: 11, created: 2 },
  ] }));
  put(join(h, ".local/share/ai-collab/tasks/b.json"), "not json");
  const { tasks } = await taskStoreSource({ home: h }).load();
  assert.deepEqual(tasks, [
    { id: "t1", status: "done", updated: 10, created: 1, progress: 2 },
    { id: "t2", status: "open", updated: 11, created: 2, progress: 0 },
  ]);
});

test("taskStoreSource with no tasks directory returns an empty list", async () => {
  const { tasks } = await taskStoreSource({ home: home() }).load();
  assert.deepEqual(tasks, []);
});

test("journalSource keeps only ok/failed schedule lines inside the window and skips other lines", async () => {
  const line = (message, ts) => JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: String(ts * 1000) });
  const raw = [
    line("nightly-report: ok in 120 ms", 1000),
    line("nightly-report: failed in 5 ms", 2000),
    line("unrelated line", 3000),
    "not json",
    line("late: ok in 9 ms", 9000),
  ].join("\n");
  const src = journalSource({ run: () => raw });
  const { scheduleRuns } = await src.load({ since: 1000, until: 5000 });
  assert.deepEqual(scheduleRuns, [
    { name: "nightly-report", ok: true, ms: 120, ts: 1000 },
    { name: "nightly-report", ok: false, ms: 5, ts: 2000 },
  ]);
});

test("journalSource reports a failed journalctl run as a note and no schedule runs", async () => {
  const src = journalSource({ run: () => { throw new Error("journalctl: no such unit\nmore"); } });
  const out = await src.load({});
  assert.deepEqual(out, { scheduleRuns: [], notes: ["journalctl unavailable: journalctl: no such unit"] });
});
