import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, parseEnvelope, sendMessage } from "../lib/inbox.mjs";
import { respond, sendAndAwait, waitForMessages } from "../lib/agents.mjs";
import { processStart } from "../lib/process.mjs";
import { agentDirectory, listSessions, recordSession, setIdentity } from "../lib/sessions.mjs";
import { formatInbox } from "../lib/format.mjs";
import { runCli } from "../lib/cli.mjs";

const A = sessionLabel("session-a");
const B = sessionLabel("session-b");

function pair(fake) {
  const stateDir = peerEnv(fake).AI_COLLAB_STATE_DIR;
  const envA = peerEnv(fake, { peer: "alice", stateDir, AI_COLLAB_SESSION: A });
  const envB = peerEnv(fake, { peer: "bob", stateDir, AI_COLLAB_SESSION: B });
  return { envA, envB, alice: loadConfig(envA), bob: loadConfig(envB) };
}

test("urgent message skips the hook poll throttle once; a normal one waits for it", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { alice, bob } = pair(fake);
  bob.pollIntervalMs = 60_000;
  assert.deepEqual(await claimInbox(bob, { throttle: true }), []); // first poll sets lastPollAt
  await sendMessage(alice, `bob#${B}`, "normal");
  assert.deepEqual(await claimInbox(bob, { throttle: true }), []);
  await new Promise((r) => setTimeout(r, 5));
  const sent = await sendMessage(alice, `bob#${B}`, "stop and read this", { urgent: true });
  const got = await claimInbox(bob, { throttle: true });
  assert.deepEqual(got.map((m) => [m.body, m.urgent === true]), [["normal", false], ["stop and read this", true]]);
  assert.equal(got[1].id, sent.id);
  assert.equal(parseEnvelope(fake.state.publishes.at(-1).message).urgent, true);
  assert.match(formatInbox(got), /marked URGENT/);
  assert.deepEqual(await claimInbox(bob, { throttle: true }), []); // the marker is spent
});

test("respond answers a peer message in its sender's inbox; send await_reply returns the answer", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { alice, bob } = pair(fake);
  alice.stopPollMs = 50;
  const waiting = sendAndAwait(alice, `bob#${B}`, "review PR 12?", { awaitSeconds: 5 });
  let question;
  for (let i = 0; i < 50 && !question; i += 1) {
    [question] = await claimInbox(bob);
    if (!question) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(question.body, "review PR 12?");
  assert.deepEqual(await respond(bob, question.id, "working"), { sent: true, to: `alice#${A}`, state: "working" });
  await respond(bob, question.id, "reply", "LGTM");
  const result = await waiting;
  assert.equal(result.status, "replied");
  assert.deepEqual([result.reply.body, result.reply.state, result.reply.replyTo, result.reply.from], ["LGTM", "reply", question.id, `bob#${B}`]);
  assert.deepEqual(result.messages.map((m) => m.state), ["working"]);
  await assert.rejects(respond(bob, "m99999999", "done"), /unavailable/);
  await assert.rejects(respond(bob, question.id, "maybe"), /state must be/);
});

test("wait blocks until a message arrives and times out when none does", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { alice, bob } = pair(fake);
  bob.stopPollMs = 50;
  assert.deepEqual(await waitForMessages(bob, { seconds: 0 }), { status: "timeout", messages: [] });
  const waiting = waitForMessages(bob, { seconds: 5 });
  setTimeout(() => void sendMessage(alice, "bob", "ping"), 200);
  const got = await waiting;
  assert.equal(got.status, "messages");
  assert.deepEqual(got.messages.map((m) => m.body), ["ping"]);
  assert.ok(fake.state.publishes.some((p) => p.topic === "ai-collab-demo--receipts"));
});

test("set_identity is kept across hook writes and listed by list_agents", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { bob } = pair(fake);
  await assert.rejects(setIdentity(bob, { activity: "x" }), /not registered/);
  const proc = { pid: process.pid, start: "" };
  await recordSession(bob, { id: "session-b", cwd: "/tmp", harness: "claude", event: "SessionStart" });
  assert.deepEqual(await setIdentity(bob, { name: "reviewer", activity: "reviewing\nPR 12", tags: ["pr:12", "role:reviewer"] }),
    { name: "reviewer", activity: "reviewing PR 12", tags: ["pr:12", "role:reviewer"] });
  await recordSession(bob, { id: "session-b", cwd: "/tmp", harness: "claude", event: "PostToolUse", proc });
  await assert.rejects(setIdentity(bob, { tags: ["bad tag"] }), /tags/);
  const [entry] = agentDirectory(bob, { all: true });
  assert.deepEqual([entry.address, entry.project, entry.name, entry.activity, entry.tags], [`bob#${B}`, "demo", "reviewer", "reviewing PR 12", ["pr:12", "role:reviewer"]]);
  assert.deepEqual(await setIdentity(bob, { activity: "" }), { name: "reviewer", tags: ["pr:12", "role:reviewer"] });
});

test("a stopped OpenCode session is offline while its server process is still running", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { bob } = pair(fake);
  const proc = { pid: process.pid, start: processStart(process.pid) };
  await recordSession(bob, { id: "session-b", cwd: "/tmp", harness: "opencode", event: "Stop", proc });
  assert.equal(listSessions(bob).find((s) => s.harness === "opencode").online, false);
  await recordSession(bob, { id: "session-b", cwd: "/tmp", harness: "claude", event: "Stop", proc });
  assert.equal(listSessions(bob).find((s) => s.harness === "claude").online, true);
  await recordSession(bob, { id: "session-b", cwd: "/tmp", harness: "opencode", event: "UserPromptSubmit", proc });
  assert.equal(listSessions(bob).find((s) => s.harness === "opencode").online, true);
});

test("CLI send --urgent, respond and identity", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { envA, envB, bob } = pair(fake);
  const io = (env) => { const out = []; const err = []; return { env, out, err, io: { env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } } }; };
  const a = io(envA);
  assert.equal(await runCli(["send", `bob#${B}`, "now", "please", "--urgent"], a.io), 0, a.err.join(""));
  const [m] = await claimInbox(bob);
  assert.deepEqual([m.body, m.urgent], ["now please", true]);
  const b = io(envB);
  assert.equal(await runCli(["respond", m.id, "done", "shipped"], b.io), 0, b.err.join(""));
  assert.match(b.out.join(""), new RegExp(`done sent to alice#${A}`));
  const reply = parseEnvelope(fake.state.publishes.at(-1).message);
  assert.deepEqual([reply.replyTo, reply.state, reply.body], [m.id, "done", "shipped"]);
  await recordSession(bob, { id: "session-b", cwd: "/tmp", harness: "codex", event: "SessionStart" });
  const c = io(envB);
  assert.equal(await runCli(["identity", "--activity", "fixing tests", "--tag", "pr:7"], c.io), 0, c.err.join(""));
  assert.deepEqual(JSON.parse(c.out.join("")), { activity: "fixing tests", tags: ["pr:7"] });
});

test("MCP set_identity, list_agents, send and inbox", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  const { envA, bob } = pair(fake);
  await recordSession(loadConfig(envA), { id: "session-a", cwd: "/tmp", harness: "claude", event: "SessionStart" });
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const { AI_COLLAB_SESSION, ...env } = envA;
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function call(name, args) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const { result } = JSON.parse((await output.next()).value);
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  assert.deepEqual(await call("set_identity", { session: A, activity: "writing docs", tags: ["role:writer"] }), { identity: { activity: "writing docs", tags: ["role:writer"] } });
  const { agents } = await call("list_agents", { all: true });
  assert.deepEqual(agents.map((x) => [x.address, x.activity]), [[`alice#${A}`, "writing docs"]]);
  const sent = await call("send", { to: `bob#${B}`, body: "hi", session: A, urgent: true });
  assert.equal(sent.sent, true);
  const [m] = await claimInbox(bob);
  assert.deepEqual([m.id, m.urgent], [sent.id, true]);
  await sendMessage(bob, `alice#${A}`, "hello back", { replyTo: m.id, state: "reply" });
  const { messages } = await call("inbox", { session: A });
  assert.deepEqual(messages.map((x) => [x.body, x.state, x.answer_with]), [["hello back", "reply", `respond message_id=${messages[0].id}`]]);
});
