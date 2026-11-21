import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";

const SESSION = "aabbccddeeff0123";
const TOPIC = "ai-collab-demo--to--all";

test("MCP channel_history returns the channel oldest first without advancing the inbox", { timeout: 10000 }, async (t) => {
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

  async function call(args) {
    const result = await request("tools/call", { name: "channel_history", arguments: args });
    const text = result.content[0].text;
    return { isError: Boolean(result.isError), text, payload: result.isError ? null : JSON.parse(text) };
  }

  await request("initialize", { protocolVersion: "2025-11-25" });
  await sendMessage(loadConfig(peerEnv(fake, { peer: "bob" })), "all", "hello from bob");
  fake.inject(TOPIC, JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "all", body: "operator says hi" }));

  const everything = await call({ session: SESSION });
  assert.equal(everything.isError, false);
  assert.deepEqual(everything.payload.messages.map((m) => [m.from, m.body]), [["bob", "hello from bob"], ["operator", "operator says hi"]]);
  assert.match(everything.payload.messages[0].answer_with, /^respond message_id=/);
  assert.match(everything.payload.note, /untrusted/);

  const one = await call({ session: SESSION, limit: 1 });
  assert.deepEqual(one.payload.messages.map((m) => m.body), ["operator says hi"]);

  const rejected = await call({ limit: 5 });
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /session label/);

  // The inbox still holds both messages: history advanced no cursor.
  const inbox = await claimInbox(loadConfig(peerEnv(fake, { peer: "alice" })), { strict: true });
  assert.deepEqual(inbox.map((m) => m.from), ["bob", "operator"]);
});
