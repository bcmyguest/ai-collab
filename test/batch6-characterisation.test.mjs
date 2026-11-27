import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { childHint, exportParent, parentLine } from "../lib/family.ts";
import { job, runningJobs } from "../lib/job.ts";
import { pattern } from "../lib/pattern-cli.ts";
import { processStart } from "../lib/process.mjs";
import { task } from "../lib/task-cli.ts";

const UUID = "0123abcd-0123-4abc-8def-0123456789ab";
const OTHER = "fedcba98-0123-4abc-8def-0123456789ab";

function sink() {
  let text = "";
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
}

async function call(fn, argv, ctx) {
  const out = sink();
  const err = sink();
  const code = await fn(argv, { env: {}, out, err, ...ctx });
  return { code, out: out.text, err: err.text };
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-batch6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cfg = { enabled: true, peer: "p1", session: "s1", project: "demo", stateDir: "/nonexistent" };

test("exportParent appends the export line once and only for an absolute file with a session", (t) => {
  const dir = scratch(t);
  const file = join(dir, "env");
  writeFileSync(file, "export A=1");
  assert.equal(exportParent({ ...cfg, session: "" }, file), false);
  assert.equal(exportParent(cfg, "relative/env"), false);
  assert.equal(exportParent(cfg, 42), false);
  assert.equal(exportParent(cfg, file), true);
  assert.equal(exportParent(cfg, file), false);
  assert.equal(readFileSync(file, "utf8"), "export A=1\nexport AI_COLLAB_PARENT=p1#s1\n");
  const fresh = join(dir, "fresh");
  assert.equal(exportParent(cfg, fresh), true);
  assert.equal(readFileSync(fresh, "utf8"), "export AI_COLLAB_PARENT=p1#s1\n");
  assert.equal(exportParent(cfg, join(dir, "missing", "env")), false);
});

test("childHint points every host at spawn_agent, not shell starts", () => {
  assert.equal(childHint({ ...cfg, session: "" }), "");
  const hint = childHint(cfg);
  assert.ok(hint.startsWith("[ai-collab] To hand work to another agent, call the ai-collab spawn_agent tool"));
  assert.ok(hint.includes("Do not start harnesses from your shell."));
  assert.ok(!hint.includes("codex exec"));
});

test("parentLine names the parent and the child's own address", () => {
  assert.equal(parentLine(cfg), "");
  assert.equal(parentLine({ ...cfg, parent: "boss#main", session: "" }), "");
  assert.equal(parentLine({ ...cfg, parent: "boss#main" }),
    "[ai-collab] You were started by the agent boss#main; your address is p1#s1. "
    + `Report to it with the ai-collab send_to_peer tool (to="boss#main", session="s1") `
    + `or AI_COLLAB_PEER=p1 AI_COLLAB_SESSION=s1 ai-collab send boss#main "<message>".`);
});

test("runningJobs counts live job records and removes dead ones", (t) => {
  const dir = scratch(t);
  const live = `p1#s1.job-${UUID}.json`;
  const dead = `p1#s1.job-${OTHER}.json`;
  const odd = "p1#s1.job-not-a-uuid.json";
  const foreign = `p2#s1.job-${UUID}.json`;
  writeFileSync(join(dir, live), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  writeFileSync(join(dir, dead), JSON.stringify({ pid: process.pid, start: "not-the-start" }));
  writeFileSync(join(dir, odd), "{}");
  writeFileSync(join(dir, foreign), "{}");
  assert.equal(runningJobs(dir, "p1#s1", [live, dead, odd, foreign, `p1#s1.job-${"a".repeat(36)}.json`]), 1);
  assert.ok(existsSync(join(dir, live)));
  assert.ok(!existsSync(join(dir, dead)));
  assert.ok(existsSync(join(dir, odd)));
  assert.ok(existsSync(join(dir, foreign)));
});

test("job prints usage, refuses bad argv, a disabled config and an unregistered session", async () => {
  const usage = "usage: ai-collab job run -- <command> [args...]\n";
  for (const argv of [[], ["help"], ["--help"], ["-h"], ["run", "--help"], ["run", "-h"]]) {
    assert.deepEqual(await call(job, argv, { cfg }), { code: 0, out: usage, err: "" }, argv.join(" "));
  }
  for (const argv of [["start"], ["run", "true"], ["run", "--"]]) {
    assert.deepEqual(await call(job, argv, { cfg }), { code: 2, out: "", err: usage }, argv.join(" "));
  }
  assert.deepEqual(await call(job, ["run", "--", "true"], { cfg: { enabled: false, reason: "off" } }), { code: 1, out: "", err: "ai-collab: job: off\n" });
  const unregistered = "ai-collab: job: Set AI_COLLAB_PEER and AI_COLLAB_SESSION to your registered session\n";
  assert.deepEqual(await call(job, ["run", "--", "true"], { cfg, registered: () => false }), { code: 1, out: "", err: unregistered });
  assert.deepEqual(await call(job, ["run", "--", "true"], { cfg: { ...cfg, session: "" }, registered: () => true }), { code: 1, out: "", err: unregistered });
});

test("pattern refuses a disabled config, bad argv and unknown commands before touching state", async () => {
  assert.deepEqual(await call(pattern, ["list"], { cfg: { enabled: false, reason: "off" } }), { code: 2, out: "", err: "ai-collab: disabled: off\n" });
  const cases = [
    [["list", "x"], "usage: pattern list"],
    [["show"], "usage: pattern show <name>"],
    [["show", "a", "b"], "usage: pattern show <name>"],
    [["create", "a", "b"], "usage: pattern create <file.json | ->"],
    [["delete"], "usage: pattern delete <name>"],
    [["start"], `usage: pattern start <name> "<task>"`],
    [["runs", "x"], "usage: pattern runs"],
    [["status"], "usage: pattern status <run-id>"],
    [["advance", "r1"], `usage: pattern advance <run-id> "<event>" ["note"]`],
  ];
  for (const [argv, usage] of cases) {
    assert.deepEqual(await call(pattern, argv, { cfg }), { code: 1, out: "", err: `ai-collab: ${usage}\n` }, argv.join(" "));
  }
  assert.deepEqual(await call(pattern, ["frob"], { cfg }), { code: 1, out: "", err: `ai-collab: unknown pattern command "frob"\n` });
  assert.deepEqual(await call(pattern, ["start", "p"], { cfg, io: { readStdin: async () => "  " } }), { code: 1, out: "", err: "ai-collab: pattern start: missing task\n" });
  assert.deepEqual(await call(pattern, ["create", "/nonexistent/p.json"], { cfg }),
    { code: 1, out: "", err: "ai-collab: pattern: ENOENT: no such file or directory, open '/nonexistent/p.json'\n" });
});

test("task prints help, per-command usage and refuses a missing project", async () => {
  const help = await call(task, [], { cfg });
  assert.equal(help.code, 0);
  assert.ok(help.out.startsWith("usage: ai-collab task <command>\nusage: task outcomes\n"));
  assert.ok(help.out.endsWith("usage: task import <feature-requests.md | tasks.json>\n"));
  assert.deepEqual(await call(task, ["help"], { cfg }), help);
  assert.deepEqual(await call(task, ["-h"], { cfg }), help);
  assert.deepEqual(await call(task, ["show", "--help"], { cfg }), { code: 0, out: "ai-collab: usage: task show <id>\n", err: "" });
  const unknown = await call(task, ["frob", "-h"], { cfg });
  assert.equal(unknown.code, 1);
  assert.equal(unknown.err, `ai-collab: task: unknown command "frob"\n${help.out}`);
  assert.deepEqual(await call(task, ["list"], { cfg: { ...cfg, project: "" } }),
    { code: 2, out: "", err: "ai-collab: task: AI_COLLAB_PROJECT is not set and no project matches this folder\n" });
});
