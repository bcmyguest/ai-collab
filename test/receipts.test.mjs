import { parseWireEnvelope } from "../lib/agui.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishActivity } from "../lib/activity.ts";
import { loadConfig, MESSAGE_MAX_BYTES, receiptsTopic, sessionLabel } from "../lib/config.mjs";
import { claimInbox, publishStatus, sendMessage } from "../lib/inbox.mjs";
import { readReceipts, receiptMessages, sendReceipts, settleReceipts } from "../lib/receipts.mjs";
import { runCli } from "../lib/cli.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const base = "http://127.0.0.1:8795";

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

const receipts = (fake) => fake.state.publishes.filter((p) => p.topic === receiptsTopic("demo")).map((p) => parseWireEnvelope(p.message));

test("receipt envelopes batch ids under ntfy's byte cap", () => {
  const cfg = { peer: "alice", session: "0123456789abcdef" };
  const ids = Array.from({ length: 300 }, (_, i) => `id-${String(i).padStart(60, "0")}`);
  const messages = receiptMessages(cfg, ids, "2026-01-01T00:00:00.000Z");
  assert.ok(messages.length > 1);
  for (const m of messages) assert.ok(Buffer.byteLength(m) <= MESSAGE_MAX_BYTES);
  const parsed = messages.map(parseWireEnvelope);
  assert.deepEqual(parsed.flatMap((m) => m.ids), ids);
  assert.deepEqual(Object.keys(parsed[0]), ["v", "kind", "from", "session", "ids", "state", "ts"]);
  const reads = readReceipts(messages.map((message) => ({ message })));
  assert.deepEqual([...reads.get(ids[0])], ["alice#0123456789abcdef"]);
});

test("a hook delivery publishes one read receipt for the delivered ids", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const bob = loadConfig(peerEnv(fake, { peer: "bob" }));
  await sendMessage(bob, "alice", "one");
  await sendMessage(bob, "all", "@alice two");
  const ids = fake.state.publishes.map((p) => p.id);
  const r = await runHook({ hook_event_name: "SessionStart", session_id: "s-1", cwd: "/tmp" }, env);
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /body="@alice two"/);
  const [receipt, ...more] = receipts(fake);
  assert.equal(more.length, 0);
  assert.deepEqual({ ...receipt, ts: "" }, { v: 1, kind: "receipt", from: "alice", session: sessionLabel("s-1"), ids, state: "read", ts: "" });
  const publish = fake.state.publishes.find((p) => p.topic === receiptsTopic("demo"));
  assert.equal(publish.title, "ai-collab receipt");
});

test("a failed receipt publish leaves hook delivery intact", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  await sendMessage(loadConfig(peerEnv(fake, { peer: "bob" })), "alice", "still delivered");
  const cfg = loadConfig(env);
  fake.state.failNext = 1;
  sendReceipts(cfg, ["m00000001"]);
  await settleReceipts();
  assert.equal(receipts(fake).length, 0);
  const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-2", cwd: "/tmp", prompt: "x" }, env);
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /still delivered/);
});

test("the CLI inbox publishes a read receipt", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  await sendMessage(loadConfig(peerEnv(fake, { peer: "bob" })), "alice", "cli");
  let out = "";
  assert.equal(await runCli(["inbox"], { env, stdout: { write: (s) => { out += s; } }, stderr: { write() {} } }), 0);
  assert.match(out, /cli/);
  assert.deepEqual(receipts(fake).map((r) => [r.from, r.ids]), [["alice", [fake.state.publishes[0].id]]]);
});

test("UI ticks: a direct message goes sent then read; a broadcast sent, delivered (some read), read", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const peer = (name, session) => ({ ...loadConfig(peerEnv(fake, { peer: name })), session });
  const bob = peer("bob", "0000000000000001");
  const carol = peer("carol", "0000000000000003");
  await publishStatus(bob, { event: "start", harness: "codex" });
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "alice" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const post = (body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "send");
  const deliver = async (cfg) => {
    sendReceipts(cfg, (await claimInbox(cfg)).map((m) => m.id));
    await settleReceipts();
  };

  // Reads states until the message shows the expected ticks; next() keeps the stream open for the next call.
  const states = async (stream, body, expected) => {
    for (;;) {
      const { done, value } = await stream.next();
      assert.ok(!done, `stream ended before ${body} was ${expected}`);
      const m = value.event === "state" && value.data.messages.find((item) => item.body === body);
      if (m?.receipt === expected) return m;
    }
  };

  const direct = sse(ui.events(new Request(`${base}/api/events?session=carol%23${carol.session}`, { signal: ctrl.signal })));
  assert.equal((await post({ target: `carol#${carol.session}`, body: "dm" })).status, 201);
  await states(direct, "dm", "sent");
  await publishActivity(carol, "claude", [{ type: "prompt", input: "dm" }]);
  const all = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
  const project = (await all.next()).value;
  assert.equal(project.event, "state");
  assert.equal(project.data.messages.some(m => m.body === "dm"), false);
  await publishStatus(carol, { event: "start", harness: "claude" });
  await deliver(carol);
  await states(direct, "dm", "read");

  const broadcast = "@bob @carol everyone";
  assert.equal((await post({ target: "all", body: broadcast })).status, 201);
  await states(all, broadcast, "sent");
  await deliver(bob);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const fresh = (await sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal }))).next()).value;
  assert.equal(fresh.data.messages.find((m) => m.body === broadcast).receipt, "delivered");
  await deliver(carol);
  await states(all, broadcast, "read");
});
