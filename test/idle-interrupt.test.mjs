import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionLabel } from "../lib/config.mjs";
import { sessionIdleState } from "../lib/idle.mjs";
import { codexLiveInterrupt, interruptSession } from "../lib/interrupt.mjs";
import { activeOpencodeSessions, opencodeRequest } from "../lib/opencode-api.mjs";

const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OPENCODE_ID = "ses_0123456789abcdefghijABCDEFGH";

// A fake OpenCode service on loopback plus the service.json that points at it.
async function fakeOpencode(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined });
    const [status, body] = handler(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const state = mkdtempSync(join(tmpdir(), "oc-state-"));
  mkdirSync(join(state, "opencode"));
  writeFileSync(join(state, "opencode", "service.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password: "pw" }));
  return { env: { XDG_STATE_HOME: state, HOME: state }, requests };
}

test("opencodeRequest reads the service endpoint, sends basic auth, and reports a missing service", async (t) => {
  const { env, requests } = await fakeOpencode(t, () => [200, { data: { [OPENCODE_ID]: {} } }]);
  assert.deepEqual([...await activeOpencodeSessions({ env })], [OPENCODE_ID]);
  assert.equal(requests[0].auth, `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  const none = await opencodeRequest("GET", "/api/session/active", { env: { HOME: tmpdir(), XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "none-")) } });
  assert.equal(none.ok, false);
  assert.equal(await activeOpencodeSessions({ env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "none-")) } }), null);
});

test("opencodeRequest refuses a non-loopback service URL", async () => {
  const state = mkdtempSync(join(tmpdir(), "oc-remote-"));
  mkdirSync(join(state, "opencode"));
  writeFileSync(join(state, "opencode", "service.json"), JSON.stringify({ url: "http://example.com:4096" }));
  const r = await opencodeRequest("GET", "/api/session/active", { env: { XDG_STATE_HOME: state }, fetchFn: () => assert.fail("no request") });
  assert.equal(r.ok, false);
});

test("sessionIdleState: Claude reads its session file, OpenCode the active API, Codex and Cursor the last hook event", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const claude = { harness: "claude", pid: 4242, sessionId: "abc-session" };
  const write = (status, sessionId = "abc-session") => writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId, status }));
  write("idle");
  assert.equal(await sessionIdleState(claude, { home }), "idle");
  write("busy");
  assert.equal(await sessionIdleState(claude, { home }), "busy");
  write("idle", "other-session");
  assert.equal(await sessionIdleState(claude, { home }), "unknown");
  assert.equal(await sessionIdleState({ harness: "claude", sessionId: "x" }, { home }), "unknown");

  const { env } = await fakeOpencode(t, () => [200, { data: { [OPENCODE_ID]: {} } }]);
  assert.equal(await sessionIdleState({ harness: "opencode", sessionId: OPENCODE_ID }, { env }), "busy");
  assert.equal(await sessionIdleState({ harness: "opencode", sessionId: "ses_other0123456789abcdefghij" }, { env }), "idle");
  assert.equal(await sessionIdleState({ harness: "opencode", sessionId: OPENCODE_ID }, { env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "none-")) } }), "unknown");

  assert.equal(await sessionIdleState({ harness: "codex", event: "Stop" }), "idle");
  assert.equal(await sessionIdleState({ harness: "codex", event: "pretooluse" }), "busy");
  assert.equal(await sessionIdleState({ harness: "cursor", event: "UserPromptSubmit" }), "busy");
});

function peer(harness, sessionId) {
  return { id: `${harness}#${sessionLabel(sessionId)}`, harness, sessionId, cwd: "/tmp" };
}

test("interruptSession: OpenCode posts to the interrupt API and reports the outcome", async () => {
  const calls = [];
  const opencode = (answer) => async (method, path) => { calls.push([method, path]); return answer; };
  const session = peer("opencode", OPENCODE_ID);
  assert.equal((await interruptSession(session, { opencode: opencode({ ok: true, body: { interrupted: true } }) })).status, "succeeded");
  assert.deepEqual(calls[0], ["POST", `/api/session/${OPENCODE_ID}/interrupt`]);
  assert.equal((await interruptSession(session, { opencode: opencode({ ok: true, body: { data: { interrupted: false } } }) })).status, "not-running");
  assert.equal((await interruptSession(session, { opencode: opencode({ ok: false, status: 404, error: "404" }) })).status, "not-running");
  assert.equal((await interruptSession(session, { opencode: opencode({ ok: false, status: null, error: "OpenCode service is not running" }) })).status, "failed");
});

test("interruptSession: Codex goes through the app-server, Claude and Cursor are unsupported, bad ids are refused", async () => {
  const session = peer("codex", CODEX_ID);
  const seen = [];
  const codexInterrupt = (status) => async (threadId, options) => { seen.push([threadId, options.command]); return { status }; };
  const env = { PATH: "/usr/bin" };
  assert.equal((await interruptSession(session, { env, runner: { kind: "host" }, codexInterrupt: codexInterrupt("interrupted") })).status, "succeeded");
  assert.deepEqual(seen[0], [CODEX_ID, ["codex", ["app-server", "proxy"]]]);
  assert.equal((await interruptSession(session, { env, runner: { kind: "host" }, codexInterrupt: codexInterrupt("not-running") })).status, "not-running");
  assert.equal((await interruptSession(session, { env, runner: { kind: "host" }, codexInterrupt: codexInterrupt("not-loaded") })).status, "unsupported");
  assert.equal((await interruptSession(session, { env, runner: { kind: "host" }, codexInterrupt: async () => { throw new Error("x"); } })).status, "failed");
  for (const harness of ["claude", "cursor"]) assert.equal((await interruptSession(peer(harness, CODEX_ID))).status, "unsupported");
  assert.equal((await interruptSession({ ...session, sessionId: "not-a-uuid" })).status, "unsupported");
  assert.equal((await interruptSession(undefined)).status, "unsupported");
});

// Fake `codex app-server proxy`: one loaded thread whose newest turn t2 is in progress; interrupting any other turn errors.
const FAKE_APP_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const thread = process.argv[1];
const reply = (id, result, error) => process.stdout.write(JSON.stringify(error ? { id, error: { message: error } } : { id, result }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "thread/loaded/list") reply(m.id, { data: process.argv[2] === "unloaded" ? [] : [thread] });
  else if (m.method === "thread/read") reply(m.id, { thread: { turns: [{ id: "t1", status: "completed" }, { id: "t2", status: process.argv[2] === "idle" ? "completed" : "inProgress" }] } });
  else if (m.method === "turn/interrupt") m.params.turnId === "t2" && m.params.threadId === thread ? reply(m.id, {}) : reply(m.id, null, "wrong turn");
  else reply(m.id, {});
});`;

test("codexLiveInterrupt interrupts the in-progress turn of a loaded thread", async () => {
  const run = (mode) => codexLiveInterrupt(CODEX_ID, { cwd: "/tmp", env: process.env, command: [process.execPath, ["-e", FAKE_APP_SERVER, CODEX_ID, mode]] });
  assert.deepEqual(await run("busy"), { status: "interrupted" });
  assert.deepEqual(await run("idle"), { status: "not-running" });
  assert.deepEqual(await run("unloaded"), { status: "not-loaded" });
});
