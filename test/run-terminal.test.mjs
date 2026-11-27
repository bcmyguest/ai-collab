import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { approvalMessage } from "../lib/approvals.ts";
import { broadcastTopic, loadConfig } from "../lib/config.ts";
import { createRunRequest, decideRun, runStatus, sha256, waitForRun } from "../lib/run-terminal.ts";
import { toolClient } from "../lib/tool-api.ts";
import { publish } from "../lib/messaging.ts";
import { createUi } from "../web/server/ui.ts";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { ChipApi, aiCollabCatalog } from "../web/lib/a2ui-catalog.js";
import { runAnswer, runOperations, runOutcome } from "../web/lib/a2ui-run.js";
import { runTerminalUi } from "../web/server/run-terminal.ts";
import { ScriptApi } from "../web/lib/a2ui-run-catalog.js";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const SESSION = "0123456789abcdef";
const ON = { AI_COLLAB_RUN_IN_TERMINAL: "1" };

// A config with a session, a scratch cwd, and a script that appends one line to a marker file per run.
function setup(extra = {}) {
  const env = { ...peerEnv({ url: "http://127.0.0.1:9" }, { peer: "claude" }), ...ON, ...extra };
  const cfg = loadConfig(env, { session: SESSION });
  const cwd = tempDir({ after }, "ai-collab-run-");
  const marker = path.join(cwd, "ran.txt");
  const script = `echo ran >> ${marker}\necho out\necho err >&2\n`;
  return { env, cfg, cwd, marker, script };
}

const auditLines = (cfg) => readFileSync(path.join(cfg.stateDir, "run-terminal-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("run_in_terminal is not listed unless the flag is on", () => {
  const { env } = setup({ AI_COLLAB_RUN_IN_TERMINAL: "0" });
  const names = toolClient({ env, host: "claude" }).listTools().map((tool) => tool.name);
  assert.ok(!names.includes("run_in_terminal"));
  assert.ok(toolClient({ env: { ...env, ...ON }, host: "claude" }).listTools().some((tool) => tool.name === "run_in_terminal"));
});

test("a sandboxed or builder caller cannot list, call, or create a run request", async () => {
  const { env, cfg, cwd, script } = setup();
  for (const flag of [{ OPENSHELL_SANDBOX: "1" }, { AI_COLLAB_BUILDER: "b1" }, { AI_COLLAB_SANDBOX_OUT: "/out" }]) {
    const client = toolClient({ env: { ...env, ...flag }, host: "claude" });
    assert.ok(!client.listTools().some((tool) => tool.name.startsWith("run_in_terminal")));
    await assert.rejects(client.callTool("run_in_terminal", { script, cwd, reason: "x", session: SESSION }), /Unknown tool/);
    assert.throws(() => createRunRequest(cfg, { script, cwd, reason: "x" }, { ...env, ...flag }), /only on the host/);
  }
});

test("bad scripts and cwds are refused at request time", () => {
  const { env, cfg, cwd } = setup();
  assert.throws(() => createRunRequest(cfg, { script: "echo ‮hidden", cwd, reason: "x" }, env), /bidi/);
  assert.throws(() => createRunRequest(cfg, { script: "echo a\recho b", cwd, reason: "x" }, env), /control/);
  assert.throws(() => createRunRequest(cfg, { script: "ls", cwd: "relative", reason: "x" }, env), /absolute/);
  assert.throws(() => createRunRequest(cfg, { script: "ls", cwd: path.join(cwd, "missing"), reason: "x" }, env), /does not exist/);
});

test("a hash that does not match the stored script is refused, closes the request, and runs nothing", () => {
  const { env, cfg, cwd, marker, script } = setup();
  const { id } = createRunRequest(cfg, { script, cwd, reason: "land" }, env);
  assert.throws(() => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id, decision: "run", sha256: sha256("echo other"), env }), /hash does not match/);
  assert.equal(runStatus(cfg.stateDir, cfg.project, id).status, "refused");
  assert.equal(existsSync(marker), false);
  // A script swapped after the operator saw it fails the same check: the server hashes the bytes it is about to run.
  const second = createRunRequest(cfg, { script, cwd, reason: "land" }, env);
  const file = path.join(cfg.stateDir, cfg.project, "run-terminal", second.id, "request.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), script: "touch pwned" }));
  assert.throws(() => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id: second.id, decision: "run", sha256: second.sha256, env }), /hash does not match/);
  assert.equal(existsSync(path.join(cwd, "pwned")), false);
  assert.ok(auditLines(cfg).some((line) => line.event === "refused" && line.id === id));
});

test("an expired request is refused and reported as expired", () => {
  const { env, cfg, cwd, marker, script } = setup();
  const { id, sha256: hash } = createRunRequest(cfg, { script, cwd, reason: "land" }, env, Date.now() - 16 * 60 * 1000);
  assert.throws(() => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id, decision: "run", sha256: hash, env }), /expired/);
  assert.equal(runStatus(cfg.stateDir, cfg.project, id).status, "expired");
  assert.equal(existsSync(marker), false);
  assert.ok(auditLines(cfg).some((line) => line.event === "expired" && line.id === id));
});

test("a request runs at most once", async () => {
  const { env, cfg, cwd, marker, script } = setup();
  const { id, sha256: hash } = createRunRequest(cfg, { script, cwd, reason: "land" }, env);
  const decide = () => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id, decision: "run", sha256: hash, env });
  assert.equal(decide().status, "running");
  assert.throws(decide, /already decided/);
  assert.throws(() => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id, decision: "reject", env }), /already decided/);
  const done = await waitForRun(cfg, id, 10);
  assert.equal(done.status, "done");
  assert.equal(done.exitCode, 0);
  assert.equal(done.stdoutTail, "out\n");
  assert.equal(done.stderrTail, "err\n");
  assert.throws(decide, /already decided/);
  assert.equal(readFileSync(marker, "utf8"), "ran\n");
});

test("a script past its timeout is killed", async () => {
  const { env, cfg, cwd } = setup();
  const { id, sha256: hash } = createRunRequest(cfg, { script: "sleep 30", cwd, reason: "slow", timeoutS: 1 }, env);
  decideRun({ stateDir: cfg.stateDir, project: cfg.project, id, decision: "run", sha256: hash, env });
  const done = await waitForRun(cfg, id, 10);
  assert.equal(done.timedOut, true);
  assert.ok(done.durationMs < 9000);
});

test("bus replies and approval answers cannot run a request", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = { ...peerEnv(fake, { peer: "claude" }), ...ON };
  const cfg = loadConfig(env, { session: SESSION });
  const cwd = tempDir(t, "ai-collab-run-");
  const { id } = createRunRequest(cfg, { script: "touch ran", cwd, reason: "land" }, env);
  const ui = createUi({ cfg, env });
  t.after(() => ui.close());
  // Every way a bus writer answers a card: a reply line, an approval envelope with the same id, and /api/approve.
  for (const body of [`reply ${id} allow`, `reply ${id} run`]) await publish(cfg, broadcastTopic(cfg.project), body);
  await publish(cfg, broadcastTopic(cfg.project), approvalMessage(cfg, "claude", { tool: "Bash", summary: "touch ran" }, { id: id.slice(0, 12), expiresAt: Date.now() + 60_000 }));
  const approve = await ui.handle(new Request(`${base}/api/approve`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", id, decision: "allow" }),
  }), "approve");
  assert.notEqual(approve.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runStatus(cfg.stateDir, cfg.project, id).status, "pending");
  assert.equal(existsSync(path.join(cwd, "ran")), false);
});

test("end to end: the agent requests, the UI shows the script and hash, a click runs it, and the agent reads the result", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = { ...peerEnv(fake, { peer: "claude" }), ...ON };
  const cfg = loadConfig(env);
  const cwd = tempDir(t, "ai-collab-run-");
  const client = toolClient({ env, host: "claude" });
  const script = "printf 'landed %s\\n' \"$(basename \"$PWD\")\"\nexit 3\n";
  const created = await client.callTool("run_in_terminal", { script, cwd, reason: "Land the branch", session: SESSION });
  assert.equal(created.status, "pending");
  assert.equal(created.sha256, sha256(script));
  assert.equal((await client.callTool("run_in_terminal_result", { id: created.id, wait_seconds: 0 })).status, "pending");

  const ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  t.after(() => { clearTimeout(timer); ctrl.abort(); ui.close(); });
  const stream = sse(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })));
  const post = (userAction) => ui.handle(new Request(`${base}/api/a2ui`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", forwardedProps: { a2uiAction: { userAction } } }),
  }), "a2ui");
  let clicked = false;
  let finished = false;
  for await (const frame of stream) {
    if (frame.event !== "surface" || frame.data.id !== "run-" + created.id) continue;
    const components = frame.data.operations.find((op) => op.updateComponents).updateComponents.components;
    const model = frame.data.operations.find((op) => op.updateDataModel).updateDataModel.value;
    if (!clicked) {
      // The card carries the exact bytes, cwd, reason, session and hash; the fake browser hashes what it would show.
      assert.equal(model.script, script);
      const shown = components.find((c) => c.id === "script");
      assert.equal(shown.sha256, created.sha256);
      assert.equal(components.find((c) => c.id === "cwd").text, cwd);
      assert.equal(components.find((c) => c.id === "reason").text, "Land the branch");
      assert.equal(components.find((c) => c.id === "from").text, `From claude#${SESSION}`);
      const run = components.find((c) => c.id === "run");
      const userAction = { name: run.action.event.name, surfaceId: frame.data.id, sourceComponentId: "run", timestamp: new Date().toISOString(), context: { ...run.action.event.context, sha256: sha256(model.script) } };
      assert.equal((await post({ ...userAction, context: { ...userAction.context, sha256: sha256("x") } })).status, 409);
      clicked = true;
      continue;
    }
    if (JSON.stringify(frame.data.operations).includes("Refused")) { finished = true; break; }
  }
  assert.ok(finished, "the refused click closes the card");

  // A fresh request, then the real click with the matching hash.
  const second = await client.callTool("run_in_terminal", { script, cwd, reason: "Land the branch", session: SESSION });
  const ok = await post({ name: "run", surfaceId: "run-" + second.id, sourceComponentId: "run", timestamp: new Date().toISOString(), context: { id: second.id, sha256: sha256(script) } });
  assert.equal(ok.status, 201);
  const result = await client.callTool("run_in_terminal_result", { id: second.id, wait_seconds: 10 });
  assert.equal(result.status, "done");
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdoutTail, `landed ${path.basename(cwd)}\n`);
  assert.ok(Number.isFinite(result.durationMs));
  await until(() => auditLines(cfg).some((line) => line.event === "finished" && line.id === second.id));
  const events = auditLines(cfg).filter((line) => line.id === second.id).map((line) => line.event);
  assert.deepEqual(events, ["requested", "run", "finished"]);
  assert.ok(auditLines(cfg).every((line) => line.ts && line.sha256 && line.session === `claude#${SESSION}`));
});

test("the card maps only its own Run and Reject actions", () => {
  const id = "a".repeat(24);
  const ops = runOperations({ id, session: `claude#${SESSION}`, cwd: "/tmp", reason: "r", script: "ls", sha256: sha256("ls"), status: "pending", expiresAt: Date.now() + 1000, timeoutS: 5 });
  const run = ops[1].updateComponents.components.find((c) => c.id === "run");
  assert.deepEqual(run.action.event.context, { id, sha256: { path: "/shown" } });
  assert.equal(runAnswer({ name: "run", surfaceId: "run-" + id, context: { id, sha256: "" } }), null);
  assert.equal(runAnswer({ name: "run", surfaceId: "approval-" + id, context: { id, sha256: sha256("ls") } }), null);
  assert.deepEqual(runAnswer({ name: "reject", surfaceId: "run-" + id, context: { id } }), { id, decision: "reject" });
});

test("every run card state passes the A2UI processor with the Script component", () => {
  const request = { id: "b".repeat(24), session: `claude#${SESSION}`, cwd: "/tmp", reason: "r", script: "ls\n", sha256: sha256("ls\n"), expiresAt: Date.now() + 60_000, timeoutS: 5 };
  const states = [
    { status: "pending" }, { status: "pending", expiresAt: 0 }, { status: "rejected", by: "operator" }, { status: "expired" },
    { status: "refused", why: "the script hash does not match what was shown" }, { status: "running", stdoutTail: "a" },
    { status: "done", exitCode: 0, durationMs: 120, stdoutTail: "a", stderrTail: "b" }, { status: "done", timedOut: true, signal: "SIGTERM", durationMs: 5000 },
  ];
  for (const state of states) {
    const processor = new MessageProcessor([aiCollabCatalog([ChipApi, ScriptApi])]);
    const operations = runOperations({ ...request, ...state });
    assert.deepEqual(processor.processMessagesWithErrors(operations), []);
    // The processor checks structure only; the Script props must also fit the schema the browser binds.
    for (const component of operations[1].updateComponents.components.filter((c) => c.component === "Script")) {
      const { id: _id, component: _name, ...props } = component;
      assert.equal(ScriptApi.schema.safeParse(props).success, true, component.id);
    }
  }
});

// The review's repros: a swapped request, hidden characters, the script's environment, and a run lost to a restart.
const requestFile = (cfg, id) => path.join(cfg.stateDir, cfg.project, "run-terminal", id, "request.json");
const rewrite = (cfg, id, change) => writeFileSync(requestFile(cfg, id), JSON.stringify({ ...JSON.parse(readFileSync(requestFile(cfg, id), "utf8")), ...change }));
const runAction = (id, hash) => ({ name: "run", surfaceId: "run-" + id, context: { id, sha256: hash } });
const quietUi = (env) => runTerminalUi({ env, hosted: false, broadcast: () => {} });

test("a request swapped after the UI showed it keeps the shown script on the card and cannot run", () => {
  const { env, cfg, cwd, script } = setup();
  const ui = quietUi(env);
  const { id } = createRunRequest(cfg, { script, cwd, reason: "land" }, env);
  assert.equal(ui.snapshot(cfg).runRequests[0].script, script);
  const swapped = "touch pwned\n";
  rewrite(cfg, id, { script: swapped, sha256: sha256(swapped) });
  // The next snapshot would hand the browser the new script; its hash then matches and Run would run it.
  const card = ui.snapshot(cfg).runRequests[0];
  assert.equal(card.script, script);
  assert.notEqual(card.status, "pending");
  assert.throws(() => ui.answer(cfg, runAction(id, sha256(swapped)), "op"), /changed|already decided/);
  assert.equal(existsSync(path.join(cwd, "pwned")), false);
});

test("a request rewritten to a later creation time keeps its first expiry", () => {
  const { env, cfg, cwd, script } = setup();
  const ui = quietUi(env);
  const { id } = createRunRequest(cfg, { script, cwd, reason: "land" }, env);
  const shown = ui.snapshot(cfg).runRequests[0];
  const later = Date.now() + 1000;
  rewrite(cfg, id, { createdAt: later, expiresAt: later + 60 * 60 * 1000 });
  assert.equal(ui.snapshot(cfg).runRequests[0].expiresAt, shown.expiresAt);
});

test("invisible, line-separator and look-alike space characters are refused", () => {
  const { env, cfg, cwd } = setup();
  for (const hidden of ["­", "͏", "ᅟ", "᠎", " ", " ", " ", " ", "　", "ㅤ", "️", "\u{e0041}", "\u{e0100}", "⁤"]) {
    assert.throws(() => createRunRequest(cfg, { script: `echo a${hidden}b`, cwd, reason: "x" }, env), /cannot show/, `U+${hidden.codePointAt(0).toString(16)}`);
  }
});

test("a long run of blanks that would push text off screen is refused", () => {
  const { env, cfg, cwd } = setup();
  assert.throws(() => createRunRequest(cfg, { script: `echo hi${" ".repeat(2000)}; rm -rf ~/x`, cwd, reason: "x" }, env), /blank/);
  assert.ok(createRunRequest(cfg, { script: `${"    ".repeat(8)}echo indented`, cwd, reason: "x" }, env).id);
});

test("the script gets no UI server variables or secrets", async () => {
  const { env, cfg, cwd } = setup();
  const script = "env\n";
  const { id } = createRunRequest(cfg, { script, cwd, reason: "env" }, env);
  const uiEnv = { ...env, AI_COLLAB_TOKEN: "tok-secret", AI_COLLAB_UI_ORIGIN: "https://x.ts.net", NODE_ENV: "production", __NEXT_PRIVATE_ORIGIN: "http://x", NEXT_RUNTIME: "nodejs" };
  decideRun({ stateDir: cfg.stateDir, project: cfg.project, id, decision: "run", sha256: sha256(script), env: uiEnv });
  const done = await waitForRun(cfg, id, 10);
  assert.equal(done.exitCode, 0);
  for (const name of ["AI_COLLAB_", "NODE_ENV=", "__NEXT", "NEXT_RUNTIME"]) assert.ok(!done.stdoutTail.includes(name), name);
  assert.ok(done.stdoutTail.includes("PATH="));
});

test("a run still marked running when the UI server starts is closed as lost", async () => {
  const { env, cfg, cwd, script } = setup();
  const { id } = createRunRequest(cfg, { script, cwd, reason: "land" }, env);
  const dir = path.dirname(requestFile(cfg, id));
  writeFileSync(path.join(dir, "decision.json"), JSON.stringify({ decision: "run", by: "operator", at: Date.now() }));
  writeFileSync(path.join(dir, "result.json"), JSON.stringify({ status: "running", startedAt: Date.now() }));
  const ui = quietUi(env);
  ui.watch(cfg);
  ui.close();
  assert.equal(runStatus(cfg.stateDir, cfg.project, id).status, "lost");
  assert.equal((await waitForRun(cfg, id, 5)).status, "lost");
  assert.ok(auditLines(cfg).some((line) => line.event === "lost" && line.id === id));
  assert.match(runOutcome({ status: "lost" }), /restart/);
});
