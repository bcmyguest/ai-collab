import { parseWireEnvelope } from "../lib/agui.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { loadConfig } from "../lib/config.ts";

test("MCP asks and resumes waiting for a matching phone reply on the broadcast topic", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  const env = peerEnv(fake, { peer: "alice" });
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;

  async function request(method, params) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const line = await output.next();
    assert.equal(line.done, false);
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    assert.ok(response.result, JSON.stringify(response));
    return response.result;
  }

  async function call(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  }

  assert.equal((await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } })).serverInfo.name, "ai-collab");
  assert.deepEqual((await request("tools/list")).tools.map(({ name }) => name), ["ask_question", "wait_for_operator", "wait_for_answer", "reply_to_operator", "send_to_all", "send_to_peer", "list_sessions", "list_agents", "send", "respond", "wait", "inbox", "set_identity", "team_status", "team_start", "spawn_agent", "close_agent", "channel_history", "interrupt", "pattern_list", "pattern_start", "pattern_status", "pattern_advance", "task_list", "task_update", "builder_start"]);
  const question = await call("ask_question", {
    question: "Which option?", wait_seconds: 0, session: "aabbccddeeff0123",
  });
  assert.equal(question.status, "pending");
  const topic = "ai-collab-demo--to--all";
  const posted = fake.state.publishes.at(-1);
  assert.equal(posted.topic, topic);
  assert.match(posted.title, /alice#aabbccddeeff0123/);
  assert.ok(posted.message.includes(`reply ${question.id} YOUR ANSWER`));

  fake.inject(topic, "reply 0123456789ab wrong question");
  fake.inject(topic, JSON.stringify({ v: 1, kind: "msg", from: "bob", to: "all", body: `reply ${question.id} agent test` }));
  assert.equal((await call("wait_for_answer", { id: question.id, wait_seconds: 0 })).status, "pending");
  fake.inject(topic, `reply ${question.id} Option B`);
  assert.deepEqual(await call("wait_for_answer", { id: question.id, wait_seconds: 0 }), {
    id: question.id, status: "answered", answer: "Option B", source: "unverified channel broadcast",
  });

  const inbox = await claimInbox(loadConfig(env));
  assert.ok(!inbox.some(({ body }) => body === `reply ${question.id} Option B`));
});

test("MCP reply_to_operator answers an exact-session direct chat in the same thread", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  const session = "aabbccddeeff0123";
  const env = peerEnv(fake, { peer: "alice" });
  const operator = loadConfig({ ...env, AI_COLLAB_PEER: "operator" });
  await sendMessage(operator, `alice#${session}`, "Status?", { operatorThread: true });
  const sent = fake.state.publishes.at(-1);
  const messageId = sent.id;
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function call(name, args) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return JSON.parse((await output.next()).value).result;
  }

  const wrong = await call("reply_to_operator", { message_id: messageId, body: "hi", session: "0000000000000000" });
  assert.ok(wrong.isError);
  const ok = await call("reply_to_operator", { message_id: messageId, body: "All green", session });
  assert.ok(!ok.isError, ok.content[0].text);
  const reply = fake.state.publishes.at(-1);
  assert.equal(reply.topic, sent.topic);
  assert.deepEqual(
    (({ from, session: s, to, operatorThread, replyTo, body }) => ({ from, s, to, operatorThread, replyTo, body }))(parseWireEnvelope(reply.message)),
    { from: "alice", s: session, to: "operator", operatorThread: true, replyTo: messageId, body: "All green" },
  );
});
