import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";
import { formatInbox, identityLine, stopOutput } from "../lib/format.mjs";
import { eventToEnvelope } from "../lib/agui.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function runHook(host, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--host", host], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("direct and broadcast operator messages both carry reply instructions; peer messages do not", () => {
  const text = formatInbox([
    { id: "m1", from: "operator", to: "alice#aabbccddeeff0123", ts: "", body: "direct", operatorThread: true },
    { id: "m2", from: "operator", to: "all", ts: "", body: "broadcast", operatorBroadcast: true },
    { id: "m3", from: "ntfy", to: "all", ts: "", body: "phone", operatorBroadcast: true },
    { id: "m4", from: "bob", to: "all", ts: "", body: "peer" },
  ], { session: "aabbccddeeff0123" });
  const [, direct, broadcast, phone, peer] = text.split("\n");
  assert.match(direct, /reply_to_operator tool \(message_id="m1", session="aabbccddeeff0123"\)/);
  assert.match(broadcast, /operator broadcast\. Answer it in the shared channel with the ai-collab send_to_all tool \(reply_to="m2", session="aabbccddeeff0123", body=<your answer>\)/);
  assert.match(phone, /send_to_all tool \(reply_to="m3"/);
  assert.match(peer, /body="peer"$/);
});

test("the identity line explains every reply route", () => {
  const line = identityLine({ peer: "codex", session: "0011223344556677" });
  assert.match(line, /reply_to_operator tool/);
  assert.match(line, /send_to_all tool \(body, session="0011223344556677", reply_to=<message id>\)/);
  assert.match(line, /AI_COLLAB_PEER=codex AI_COLLAB_SESSION=0011223344556677 ai-collab send all/);
  assert.match(line, /ask_question tool/);
  assert.equal(identityLine({ peer: "codex", session: "" }), "");
});

test("stop continuation shapes: block+reason for Claude and Codex, followup_message for Cursor", () => {
  assert.deepEqual(stopOutput("claude", "x"), { decision: "block", reason: "x" });
  assert.deepEqual(stopOutput("codex", "x"), { decision: "block", reason: "x" });
  assert.deepEqual(stopOutput("cursor", "x"), { followup_message: "x" });
  assert.deepEqual(stopOutput("claude", ""), {});
});

test("each harness's Stop hook delivers a waiting operator message in its own continuation shape", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const operator = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "" }));
  const cases = [
    ["claude", { hook_event_name: "Stop", session_id: "stop-claude", stop_hook_active: false }],
    ["codex", { hook_event_name: "Stop", session_id: "stop-codex", stop_hook_active: false }],
    ["cursor", { hook_event_name: "stop", conversation_id: "stop-cursor", status: "completed", loop_count: 0 }],
  ];
  for (const [host, input] of cases) {
    const env = peerEnv(fake, { peer: host, AI_COLLAB_PEERS: "" });
    const label = sessionLabel(input.session_id || input.conversation_id);
    const sent = await sendMessage(operator, `${host}#${label}`, `status for ${host}?`, { operatorThread: true });
    assert.ok(sent.topic);
    const out = await runHook(host, input, env);
    const text = host === "cursor" ? out.followup_message : out.reason;
    if (host !== "cursor") assert.equal(out.decision, "block");
    assert.match(text, new RegExp(`body="status for ${host}\\?" Respond to the operator in this chat using the ai-collab reply_to_operator tool`));
    assert.equal(fake.state.publishes.filter((p) => p.topic.endsWith("--status") && p.message.includes(`"from":"${host}"`)).length, 0,
      "a continued session publishes no stop status");
    assert.deepEqual(await runHook(host, { ...input, stop_hook_active: true, loop_count: 1 }, env), {}, "nothing left: stop");
  }
});

test("MCP: version comes from package.json; send_to_all replies to broadcasts and drops progress in quiet mode", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  const session = "aabbccddeeff0123";
  const env = peerEnv(fake, { peer: "alice" });
  const child = spawn(process.execPath, [MCP, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function request(method, params) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return JSON.parse((await output.next()).value).result;
  }
  const call = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };

  const init = await request("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.serverInfo.version, VERSION);
  assert.match(init.instructions, /send_to_all/);
  const ask = (await request("tools/list")).tools.find((tool) => tool.name === "ask_question");
  assert.equal(ask.inputSchema.properties.important.type, "boolean");

  assert.deepEqual(await call("send_to_all", { body: "Done with step 1", session, reply_to: "m00000001" }), { sent: true, mode: "off" });
  const reply = eventToEnvelope(fake.state.publishes.at(-1).message);
  assert.equal(fake.state.publishes.at(-1).topic, "ai-collab-demo--to--all");
  assert.deepEqual([reply.from, reply.session, reply.to, reply.replyTo, reply.body], ["alice", session, "all", "m00000001", "Done with step 1"]);

  fake.inject("ai-collab-demo--to--all", JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "quiet", ts: Date.now() }));
  const { claimInbox } = await import("../lib/inbox.mjs");
  await claimInbox(loadConfig({ ...env, AI_COLLAB_SESSION: session }));
  const before = fake.state.publishes.length;
  assert.deepEqual(await call("send_to_all", { body: "50% done", session, progress: true }), {
    sent: false, reason: "AFK mode is QUIET: progress posts are dropped.",
  });
  assert.equal(fake.state.publishes.length, before);
  assert.equal((await call("send_to_all", { body: "Answer: yes", session })).sent, true, "answers still go out in quiet mode");
});
