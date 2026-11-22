import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ownEnv, sessionLabel } from "../lib/config.mjs";
import { claimInbox } from "../lib/inbox.mjs";
import { runCli } from "../lib/cli.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { eventToEnvelope } from "../lib/agui.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const PARENT = `claude#${sessionLabel(PARENT_ID)}`;
const CHILD = `codex#${sessionLabel(CHILD_ID)}`;

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify(input));
  });
}

const context = (out) => out.hookSpecificOutput?.additionalContext || out.additional_context || "";

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor" });
  return { fake, env };
}

test("a child never takes its parent's identity from the inherited environment", () => {
  const inherited = { AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude", AI_COLLAB_SESSION: "aaaaaaaaaaaaaaaa", AI_COLLAB_PARENT: "claude#aaaaaaaaaaaaaaaa" };
  const env = ownEnv(inherited, "codex");
  assert.equal(env.AI_COLLAB_PEER, "codex");
  assert.equal(env.AI_COLLAB_SESSION, undefined);
  const cfg = loadConfig(env, { host: "codex", session: "bbbbbbbbbbbbbbbb" });
  assert.deepEqual([cfg.peer, cfg.session, cfg.parent], ["codex", "bbbbbbbbbbbbbbbb", "claude#aaaaaaaaaaaaaaaa"]);
  // The parent's own shell carries AI_COLLAB_PARENT=itself: that is no parent.
  assert.equal(loadConfig({ ...inherited }, { host: "claude", session: "aaaaaaaaaaaaaaaa" }).parent, "");
  assert.equal(loadConfig({ ...inherited, AI_COLLAB_PARENT: "claude#nothex; rm" }).parent, "");
  // Cursor's agent shell exports its conversation ID; a harness started there names its Cursor parent and drops the ID.
  const fromCursor = ownEnv({ AI_COLLAB_PROJECT: "demo", CURSOR_CONVERSATION_ID: "conv-1" }, "claude");
  assert.equal(fromCursor.AI_COLLAB_PARENT, `cursor#${sessionLabel("conv-1")}`);
  assert.equal(fromCursor.CURSOR_CONVERSATION_ID, undefined);
  assert.equal(ownEnv({ CURSOR_CONVERSATION_ID: "conv-1" }, "cursor").AI_COLLAB_PARENT, undefined);
  assert.deepEqual(ownEnv({ AI_COLLAB_PEER: "x", AI_COLLAB_SESSION: "aaaaaaaaaaaaaaaa" }, "codex"), { AI_COLLAB_PEER: "x", AI_COLLAB_SESSION: "aaaaaaaaaaaaaaaa" });
});

test("parent exports its address, the child greets it once, and both can message each other", async (t) => {
  const { fake, env } = await setup(t);
  const envFile = path.join(mkdtempSync(path.join(os.tmpdir(), "ai-collab-envfile-")), "env.sh");
  const parent = await runHook(["--host", "claude"], { hook_event_name: "SessionStart", session_id: PARENT_ID, cwd: "/tmp/proj" }, { ...env, CLAUDE_ENV_FILE: envFile });
  assert.equal(readFileSync(envFile, "utf8"), `export AI_COLLAB_PARENT=${PARENT}\n`);
  assert.match(context(parent), /codex exec "<prompt>"/);
  await runHook(["--host", "claude"], { hook_event_name: "SessionStart", session_id: PARENT_ID, cwd: "/tmp/proj", source: "resume" }, { ...env, CLAUDE_ENV_FILE: envFile });
  assert.equal(readFileSync(envFile, "utf8").split("\n").filter(Boolean).length, 1, "exported once");

  // The child inherits the parent's shell: AI_COLLAB_PARENT plus, worst case, the parent's own AI_COLLAB_PEER and AI_COLLAB_SESSION.
  const childEnv = { ...env, AI_COLLAB_PARENT: PARENT, AI_COLLAB_SESSION: sessionLabel(PARENT_ID) };
  const start = { hook_event_name: "SessionStart", session_id: CHILD_ID, cwd: "/home/someone/secret/proj" };
  const child = await runHook(["--host", "codex"], start, childEnv);
  assert.match(context(child), new RegExp(`started by the agent ${PARENT}; your address is ${CHILD}`));
  await runHook(["--host", "codex"], { ...start, source: "resume" }, childEnv);

  const status = fake.state.publishes.filter(p => p.topic === "ai-collab-demo--status").map(p => eventToEnvelope(p.message)).find(s => s.harness === "codex");
  assert.deepEqual([status.from, status.session, status.parent], ["codex", sessionLabel(CHILD_ID), PARENT]);
  const parentCfg = loadConfig(env, { host: "claude", session: sessionLabel(PARENT_ID) });
  const greetings = (await claimInbox(parentCfg)).filter(m => m.body.startsWith("started:"));
  assert.deepEqual(greetings.map(m => [m.from, m.to, m.body]), [[CHILD, PARENT, `started: ${CHILD} (codex, proj)`]]);
  assert.doesNotMatch(JSON.stringify(fake.state.publishes), /secret/, "the cwd path is never published");
  const registry = path.join(env.AI_COLLAB_STATE_DIR, "demo", "registry");
  assert.equal(JSON.parse(readFileSync(path.join(registry, `${CHILD}.json`), "utf8")).parent, PARENT);

  // Parent → child through the CLI, received at the child's next hook; child → parent through MCP send_to_peer.
  const out = [];
  const io = { env: { ...env, AI_COLLAB_SESSION: sessionLabel(PARENT_ID) }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  assert.equal(await runCli(["send", CHILD, "please run the tests"], io), 0);
  const next = await runHook(["--host", "codex"], { hook_event_name: "UserPromptSubmit", session_id: CHILD_ID, cwd: "/tmp/proj", prompt: "[ai-collab] go" }, { ...childEnv, AI_COLLAB_POLL_INTERVAL_MS: "0" });
  assert.match(context(next), new RegExp(`from=${PARENT} to=${CHILD} .*please run the tests`));

  out.length = 0;
  assert.equal(await runCli(["sessions"], { ...io, env: { ...env, AI_COLLAB_PEER: undefined } }), 0);
  const line = out.join("").split("\n").find(l => l.startsWith(CHILD));
  assert.match(line, new RegExp(`codex\\t(online|offline)\\tactive \\S+\\tparent ${PARENT}\\t/tmp/proj\\tcodex exec resume ${CHILD_ID}`));

  const mcp = spawn(process.execPath, [MCP, "codex"], { env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => mcp.kill());
  const lines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  const call = async (id, name, args) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return JSON.parse((await lines.next()).value).result;
  };
  const sent = await call(1, "send_to_peer", { to: PARENT, body: "tests pass", session: sessionLabel(CHILD_ID) });
  assert.ok(!sent.isError, sent.content[0].text);
  const reply = (await claimInbox(parentCfg)).find(m => m.body === "tests pass");
  assert.equal(reply.from, CHILD, "the child's MCP server speaks as the child, not the inherited parent identity");
  const listed = JSON.parse((await call(2, "list_sessions", {})).content[0].text).sessions;
  assert.ok(listed.some(s => s.address === CHILD && s.parent === PARENT));
  assert.ok((await call(3, "send_to_peer", { to: "all", body: "x", session: sessionLabel(CHILD_ID) })).isError);
  assert.ok(readdirSync(registry).length >= 2);
});
