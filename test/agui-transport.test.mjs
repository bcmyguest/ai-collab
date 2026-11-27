import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { envelopeToEvent, parseEvent } from "../lib/agui.ts";
import { activityTopic } from "../lib/config.ts";
import { parseEnvelope } from "../lib/inbox.mjs";
import { parseMode } from "../lib/mode.ts";
import { readReceipts } from "../lib/receipts.ts";
import { publishEvent } from "../runner/publish.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const IDENTITY = { from: "codex", session: "aabbccddeeff0011" };
const THREAD = `${IDENTITY.from}#${IDENTITY.session}`;

test("runner publishes correlated AG-UI lifecycle events while readers retain the same rows", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = { enabled: true, activity: true, wire: "agui", project: "demo", peer: IDENTITY.from,
    session: IDENTITY.session, url: fake.url, timeoutMs: 1000 };
  const run = { threadId: THREAD, runId: "run-1" };
  await publishEvent(cfg, "codex", {
    ...run, type: EventType.RUN_STARTED,
    input: { ...run, tools: [], context: [], messages: [{ id: "prompt-1", role: "user", content: "go" }] },
  });
  await publishEvent(cfg, "codex", {
    ...run, type: EventType.RUN_FINISHED, outcome: { type: "cancelled" }, metadata: { aiCollab: { reason: "requested" } },
  });
  await publishEvent(cfg, "codex", {
    type: EventType.RUN_ERROR, message: "failed", metadata: { aiCollab: { runId: "run-2" } },
  });
  const messages = fake.state.publishes.filter(entry => entry.topic === activityTopic("demo")).map(entry => entry.message);
  const [started, finished, failed, stopped] = messages.map(parseEvent);
  assert.deepEqual([started.type, finished.type, failed.type, stopped.type],
    [EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR, EventType.CUSTOM]);
  assert.deepEqual([started.threadId, started.runId, started.input.messages[0].content], [THREAD, "run-1", "go"]);
  assert.deepEqual([finished.threadId, finished.runId, finished.outcome.type], [THREAD, "run-1", "cancelled"]);
  assert.deepEqual([failed.metadata.aiCollab.runId, failed.message], ["run-2", "failed"]);
  assert.deepEqual(messages.map(message => {
    const { type, input, output } = parseEnvelope(message);
    return [type, input ?? output];
  }), [["prompt", "go"], ["stop", "turn ended · interrupted · requested"], ["error", "failed"], ["stop", "turn ended · failed"]]);
});

test("message, mode and receipt readers accept AG-UI and cached legacy envelopes", () => {
  const chat = { v: 1, kind: "msg", ...IDENTITY, to: "operator", body: "hello" };
  const mode = { v: 1, kind: "mode", from: "operator", ts: 5, mode: "quiet" };
  const receipt = { v: 1, kind: "receipt", ...IDENTITY, ids: ["one"], state: "read" };
  for (const serialize of [JSON.stringify, value => JSON.stringify(envelopeToEvent(value))]) {
    assert.deepEqual(parseEnvelope(serialize(chat)), chat);
    assert.deepEqual(parseMode(serialize(mode)), { mode: "quiet", ts: 5 });
    assert.deepEqual(readReceipts([{ message: serialize(receipt) }]), new Map([["one", new Set([THREAD])]]));
  }
});
