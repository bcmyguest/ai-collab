import assert from "node:assert/strict";
import { test } from "node:test";
import { publishActivity } from "../lib/activity.mjs";
import { loadConfig } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";
import { WAKE_PROMPT } from "../lib/mode.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";

// Reads server-sent events from a streaming Response body.
async function* sse(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      if (event) yield { event, data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) };
    }
  }
}

test("session chat shows typed terminal prompts as operator messages, skipping machine text and UI echoes", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const target = `bob#${bob.session}`;

  await publishActivity(bob, "claude", [
    { type: "prompt", input: "typed in terminal" },
    { type: "prompt", input: "[ai-collab] machine text" },
    { type: "prompt", input: WAKE_PROMPT },
    { type: "prompt", input: "echoed from UI" },
    { type: "text", output: "agent reply in activity" },
  ]);
  await sendMessage(cfg, target, "echoed from UI", { operatorThread: true });

  const ui = createUi({ cfg });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const open = (query) => sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));
  const next = async (stream, name) => {
    for (;;) {
      const { value, done } = await stream.next();
      if (done) return undefined;
      if (value.event === name) return value.data;
    }
  };

  const session = await next(open(`session=${encodeURIComponent(target)}`), "state");
  const terminal = session.messages.filter(m => m.terminal);
  assert.deepEqual(terminal.map(m => [m.from, m.to, m.body, m.kind]), [["operator", target, "typed in terminal", "Message"]]);
  assert.equal(terminal[0].receipt, undefined, "terminal prompts have no delivery ticks");
  assert.deepEqual(session.messages.filter(m => m.body === "echoed from UI").map(m => m.terminal), [undefined], "the UI message stays, the echo goes");
  const times = session.messages.map(m => m.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "messages stay in time order");

  const chat = await next(open(""), "state");
  assert.equal(chat.messages.some(m => m.terminal), false, "the all-messages view has no terminal prompts");
});
