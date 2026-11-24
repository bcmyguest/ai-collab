// ai-collab's own machinery (a compaction request, a pattern-run notice) travels under the operator's address so the
// operator's reply routes still work, but no reader shows it as the operator: the chat shows a system sender, and the
// hook text says it is from ai-collab and expects no reply.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMPACT_REQUEST, controlSession } from "../lib/controls.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { formatInbox } from "../lib/format.mjs";
import { claimInbox, parseEnvelope, sendMessage } from "../lib/inbox.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const SESSION_ID = "00000000-abcd-1234-9876-000000000002";
const LABEL = sessionLabel(SESSION_ID);
const ADDRESS = "claude#" + LABEL;
// /proc/self/stat field 22: this test process stands in for a running session that no outside trigger can compact.
const selfStart = (() => { const s = readFileSync("/proc/self/stat", "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; })();
const running = { sessionId: SESSION_ID, cwd: "/tmp", harness: "claude", id: ADDRESS, pid: process.pid, pidStart: selfStart };

/** The first state a stream sends that carries a message with this exact body. */
async function stateWith(ui, query, body) {
  const ctrl = new AbortController();
  try {
    for await (const { event, data } of sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })))) {
      if (event !== "state") continue;
      const item = (data.messages || []).find(message => message.body === body);
      if (item) return item;
    }
  } finally {
    ctrl.abort();
  }
  return null;
}

test("a compaction request reaches the session as a system message, never as the operator's own", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor" });
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: "operator" });
  const result = await controlSession("compact", running, { cfg, runner: { kind: "host" } });
  assert.equal(result.status, "requested", result.detail);

  // The wire keeps the operator's address, so the operator's reply routes still work; the flag names ai-collab as author.
  const sent = parseEnvelope(fake.state.publishes.at(-1).message);
  assert.deepEqual([sent.from, sent.to, sent.toSession, sent.operatorThread, sent.system, sent.body],
    ["operator", "claude", LABEL, true, true, COMPACT_REQUEST]);

  // The hook text names ai-collab and asks for no operator-style reply.
  const agent = loadConfig({ ...env, AI_COLLAB_SESSION: LABEL });
  const [claimed] = await claimInbox(agent, { throttle: false });
  assert.equal(claimed.system, true);
  const text = formatInbox([claimed], { session: LABEL });
  assert.match(text, /from=operator \(ai-collab system message\)/);
  assert.match(text, /system message from ai-collab, not from the operator/);
  assert.doesNotMatch(text, /reply_to_operator tool/);

  // The session chat shows a system sender; the operator's own name and delivery ticks stay off it.
  const ui = createUi({ cfg: loadConfig(env), env });
  t.after(() => ui.close());
  const item = await stateWith(ui, `project=demo&session=${encodeURIComponent(ADDRESS)}`, COMPACT_REQUEST);
  assert.equal(item?.from, "system");
  assert.equal(item?.sender, "system");
  assert.equal(item?.system, true);
  assert.equal(item?.to, ADDRESS);
  assert.equal(item?.receipt, undefined);
});

test("a system broadcast (a pattern-run notice) shows as a system sender in the project chat", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude,codex,cursor" });
  const operator = loadConfig(env);
  const agent = loadConfig({ ...env, AI_COLLAB_PEER: "claude", AI_COLLAB_SESSION: LABEL });
  const notice = "@claude Pattern run 4f2c1ab failed: the reviewer could not start.";

  // Only ai-collab itself, from the operator's address, may mark a message as its own; an agent may not impersonate it.
  await assert.rejects(sendMessage(loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), "all", "from an agent", { system: true }),
    /system messages are ai-collab's own/);

  await sendMessage(operator, "all", notice, { system: true });
  const [claimed] = await claimInbox(agent);
  assert.equal(claimed.system, true);
  assert.equal(claimed.operatorBroadcast, true, "the broadcast route is unchanged");
  const text = formatInbox([claimed], { session: LABEL });
  assert.match(text, /from=operator \(ai-collab system message\) to=all/);
  assert.doesNotMatch(text, /send_to_all tool/, "a system notice asks for no channel answer");

  const ui = createUi({ cfg: operator, env });
  t.after(() => ui.close());
  const item = await stateWith(ui, "project=demo", notice);
  assert.equal(item?.from, "system");
  assert.equal(item?.to, "all");
  assert.equal(item?.system, true);
  assert.equal(item?.receipt, undefined, "a system notice is not the operator's own message");
});
