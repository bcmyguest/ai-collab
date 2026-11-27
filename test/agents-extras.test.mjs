import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, parseEnvelope } from "../lib/inbox.mjs";
import { waitForIdle } from "../lib/agents.ts";
import { agentDirectory } from "../lib/sessions.mjs";
import { runCli } from "../lib/cli.mjs";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";

const PEERS = "alice,bob,codex,claude";
const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CODEX = `codex#${sessionLabel(CODEX_ID)}`;
const MCP = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));

function register(cfg, sessionId, harness, extra = {}) {
  const address = `${harness}#${sessionLabel(sessionId)}`;
  const dir = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(dir, { recursive: true });
  writeState(join(dir, `${address}.json`), {
    id: address, sessionId, cwd: "/tmp", harness, event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid), ...extra,
  });
  return address;
}

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: PEERS });
  return { fake, env, cfg: loadConfig(env) };
}

test("list_agents filters by tags: a session needs every listed tag", async (t) => {
  const { cfg } = await setup(t);
  register(cfg, CODEX_ID, "codex", { tags: ["role:reviewer", "pr:7"] });
  register(cfg, "other-claude-session", "claude", { tags: ["role:reviewer"] });
  register(cfg, "third-session", "claude");
  assert.equal(agentDirectory(cfg).length, 3);
  assert.deepEqual(agentDirectory(cfg, { tags: ["role:reviewer"] }).map((a) => a.harness).sort(), ["claude", "codex"]);
  assert.deepEqual(agentDirectory(cfg, { tags: ["role:reviewer", "pr:7"] }).map((a) => a.address), [CODEX]);
  assert.deepEqual(agentDirectory(cfg, { tags: ["role:author"] }), []);
});

test("waitForIdle resolves idle, ended or timeout and rejects unknown or malformed addresses", async (t) => {
  const { cfg } = await setup(t);
  register(cfg, CODEX_ID, "codex", { event: "PreToolUse" });
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const states = ["busy", "busy", "idle"];
  const idle = async () => states.shift() ?? "idle";
  assert.deepEqual(await waitForIdle(cfg, CODEX, { seconds: 5, idle, sleep }), { status: "idle", address: CODEX });
  assert.equal(sleeps.length, 2);
  assert.deepEqual(await waitForIdle(cfg, CODEX, { seconds: 0, idle: async () => "busy", sleep }), { status: "timeout", address: CODEX });
  const offline = register(cfg, "dead-session", "codex", { pid: 2 ** 22 + 1, pidStart: "1" });
  assert.deepEqual(await waitForIdle(cfg, offline, { seconds: 5, idle: async () => "busy", sleep }), { status: "ended", address: offline });
  await assert.rejects(waitForIdle(cfg, `codex#${"0".repeat(16)}`, { seconds: 1 }), /Unknown agent/);
  await assert.rejects(waitForIdle(cfg, "bob", { seconds: 1 }), /session address/);
});

test("the CLI sends fyi and expect-reply messages, filters agents by tag, waits for idle, and interrupts", async (t) => {
  const { fake, env, cfg } = await setup(t);
  register(cfg, CODEX_ID, "codex", { tags: ["role:reviewer"] });
  const io = () => {
    const out = [];
    const err = [];
    return { env, stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, out, err };
  };
  let c = io();
  assert.equal(await runCli(["send", CODEX, "background note", "--priority", "fyi"], c), 0, c.err.join(""));
  assert.equal(parseEnvelope(fake.state.publishes.at(-1).message).priority, "fyi");
  c = io();
  assert.equal(await runCli(["send", CODEX, "answer me", "--expect-reply"], c), 0, c.err.join(""));
  assert.equal(parseEnvelope(fake.state.publishes.at(-1).message).expectReply, true);
  c = io();
  assert.equal(await runCli(["send", CODEX, "x", "--priority", "loud"], c), 1);
  assert.match(c.err.join(""), /priority must be/);

  c = io();
  assert.equal(await runCli(["agents", "--tag", "role:reviewer"], c), 0);
  assert.match(c.out.join(""), new RegExp(CODEX));
  c = io();
  assert.equal(await runCli(["agents", "--tag", "role:other"], c), 0);
  assert.match(c.out.join(""), /no live sessions/);

  c = io();
  assert.equal(await runCli(["wait", `idle:${CODEX}`, "1"], c), 0, c.err.join(""));
  assert.equal(c.out.join(""), `idle\t${CODEX}\n`);

  c = io();
  assert.equal(await runCli(["interrupt", `codex#${"0".repeat(16)}`], c), 1);
  assert.match(c.err.join(""), /unknown session/);
  register(cfg, "a-claude-session", "claude");
  c = io();
  assert.equal(await runCli(["interrupt", `claude#${sessionLabel("a-claude-session")}`], c), 1);
  assert.match(c.out.join(""), /unsupported/);
});

// Drives the MCP server over stdio.
function mcp(t, env) {
  const child = spawn(process.execPath, [MCP, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  return async (name, args) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const { result } = JSON.parse((await output.next()).value);
    return { error: result.isError, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
}

test("MCP send takes priority and expect_reply, list_agents takes tags, wait takes until idle", { timeout: 15000 }, async (t) => {
  const { fake, env, cfg } = await setup(t);
  register(cfg, CODEX_ID, "codex", { tags: ["role:reviewer"] });
  const call = mcp(t, env);
  const session = "aabbccddeeff0123";

  const fyi = await call("send", { to: CODEX, body: "no rush", session, priority: "fyi" });
  assert.equal(fyi.error, undefined);
  assert.equal(parseEnvelope(fake.state.publishes.at(-1).message).priority, "fyi");
  const asked = await call("send", { to: CODEX, body: "please answer", session, expect_reply: true });
  assert.equal(asked.error, undefined);
  assert.equal(parseEnvelope(fake.state.publishes.at(-1).message).expectReply, true);
  assert.match((await call("send", { to: "all", body: "x", session, expect_reply: true })).data, /direct/);

  assert.deepEqual((await call("list_agents", { tags: ["role:reviewer"] })).data.agents.map((a) => a.address), [CODEX]);
  assert.deepEqual((await call("list_agents", { tags: ["nope"] })).data.agents, []);

  assert.deepEqual((await call("wait", { session, until: `idle:${CODEX}`, seconds: 1 })).data, { status: "idle", address: CODEX });
  assert.equal((await call("wait", { session, seconds: 0 })).data.status, "timeout");
  const left = await claimInbox(loadConfig({ ...env, AI_COLLAB_PEER: "codex" }, { session: sessionLabel(CODEX_ID) }));
  assert.deepEqual(left.map((m) => [m.priority, m.expectReply]), [["fyi", undefined], [undefined, true]]);
});
