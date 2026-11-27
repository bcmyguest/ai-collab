import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EventSchema } from "@ag-ui/core/schemas";
import { buildActivity, publishActivity } from "../lib/activity.ts";
import { parseEvent, parseWireEnvelope } from "../lib/agui.mjs";
import { approvalMessage } from "../lib/approvals.mjs";
import { loadConfig } from "../lib/config.mjs";
import { publishStatus, sendMessage } from "../lib/inbox.mjs";
import { publishMode } from "../lib/mode.mjs";
import { askQuestion } from "../lib/questions.mjs";
import { sendReceipts, settleReceipts } from "../lib/receipts.mjs";
import { reportContext } from "../lib/usage.mjs";
import { approvalEndMessage, ownedApprovalMessage } from "../runner/publish.mjs";
import { createUi } from "../web/server/ui.mjs";
import { parseEnvelope, parseMode, parseQuestionText } from "./fixtures/legacy-wire.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SESSION = "aabbccddeeff0011";

for (const wire of [undefined, "legacy"]) {
  test(`structured publishers use ${wire ?? "AG-UI by default"} and keep plain questions`, async t => {
    const fake = await startFakeNtfy();
    t.after(() => fake.close());
    const cfg = { ...loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_WIRE: wire })), session: SESSION };
    await sendMessage(cfg, "bob", "direct");
    await sendMessage(cfg, "all", "broadcast");
    await publishStatus(cfg, { harness: "claude", event: "start" });
    await publishActivity(cfg, "claude", [{ type: "prompt", input: "test" }]);
    await publishMode([cfg], "quiet", { now: 123 });
    await reportContext(cfg, 250_000);
    sendReceipts(cfg, ["message-1"]);
    await settleReceipts();
    const approved = { id: "aabbccddeeff", tool: "Read", summary: "test" };
    const card = approvalMessage(cfg, "claude", approved, { id: approved.id, expiresAt: 1000 });
    const owned = ownedApprovalMessage(cfg, "claude", approved);
    const closed = approvalEndMessage(cfg, approved.id, "allowed");
    const wires = fake.state.publishes.map(p => p.message);
    const payloads = [...wires, card, owned, closed];
    if (!wire) {
      for (const payload of payloads) EventSchema.parse(JSON.parse(payload));
    }
    const messages = payloads.map(wire ? parseEnvelope : parseWireEnvelope);
    assert.deepEqual(messages.map(m => m?.kind), ["msg", "msg", "status", "activity", "mode", "alert", "receipt", "approval", "approval", "approval-end"]);
    assert.deepEqual(messages.slice(0, 2).map(m => [m.to, m.body]), [["bob", "direct"], ["all", "broadcast"]]);
    assert.deepEqual(wire ? parseMode(wires[4]) : { mode: messages[4].mode, ts: messages[4].ts }, { mode: "quiet", ts: 123 });
    assert.equal(messages.at(-2).owned, true);
    const question = await askQuestion(cfg, "Which option?", { seconds: 0 });
    assert.deepEqual(parseQuestionText(fake.state.publishes.at(-1).message), { sender: `alice#${SESSION}`, id: question.id });
  });
}

test("wire follows the project config and env and keeps distinct tool-result IDs", async t => {
  const dir = tempDir(t, "ai-collab-wire-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "ai-collab"));
  writeFileSync(join(dir, "ai-collab", "projects.json"), JSON.stringify([{ root: dir, project: "demo", wire: "legacy" }]));
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", XDG_CONFIG_HOME: dir });
  assert.equal(loadConfig(env, { cwd: dir }).wire, "legacy");
  const config = loadConfig({ ...env, AI_COLLAB_WIRE: "agui" }, { cwd: dir });
  assert.equal(config.wire, "agui");
  await sendMessage(config, "bob", "one copy");
  assert.equal(fake.state.publishes.length, 1);
  assert.equal(parseEvent(fake.state.publishes[0].message)?.name, "ai-collab.msg");
  const row = { type: "tool_result", callId: "same-call", output: "ok" };
  const results = Array.from({ length: 2 }, () => parseEvent(buildActivity(config, "claude", row).message));
  assert.ok(results.every(event => event?.type === "TOOL_CALL_RESULT" && event.toolCallId === row.callId));
  assert.notEqual(results[0].messageId, results[1].messageId);
});

test("each SSE connection sends one legacy state followed by AG-UI updates", async t => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const ui = createUi({ cfg });
  t.after(() => ui.close());
  const response = ui.events(new Request("http://localhost/api/events"));
  const stream = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  async function frame() {
    while (!buffer.includes("\n\n")) {
      const next = await stream.read();
      assert.equal(next.done, false);
      buffer += next.value;
    }
    const end = buffer.indexOf("\n\n");
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return block;
  }
  try {
    const legacy = await frame();
    assert.match(legacy, /^event: state\ndata: /);
    const snapshot = parseEvent((await frame()).slice(6));
    assert.equal(snapshot.type, "STATE_SNAPSHOT");
    assert.deepEqual(snapshot.snapshot, JSON.parse(legacy.split("\ndata: ")[1]));
    await publishMode([cfg], "quiet");
    assert.equal(parseEvent((await frame()).slice(6))?.snapshot?.mode, "quiet");
  } finally {
    await stream.cancel();
  }
});
