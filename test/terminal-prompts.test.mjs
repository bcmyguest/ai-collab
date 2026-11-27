import assert from "node:assert/strict";
import { test } from "node:test";
import { publishActivity } from "../lib/activity.ts";
import { loadConfig } from "../lib/config.ts";
import { sendMessage } from "../lib/inbox.mjs";
import { WAKE_PROMPT } from "../lib/mode.ts";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";

// A wake run's env hides operator prompts from chat; tests run outside it.
delete process.env.AI_COLLAB_WAKE;
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";

test("session chat shows typed terminal prompts as operator messages, skipping machine text and UI echoes", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_WIRE: "agui" })), session: "0000000000000001" };
  const target = `bob#${bob.session}`;

  await sendMessage(cfg, target, "echoed from UI", { operatorThread: true });
  await sendMessage(cfg, "bob", "echoed from peer inbox");
  await sendMessage(cfg, "all", "echoed from broadcast");
  assert.equal(await publishActivity(bob, "claude", [
    { type: "prompt", input: "typed in terminal" },
    { type: "prompt", input: "Builder brief", system: true },
    { type: "prompt", input: "[ai-collab] machine text" },
    { type: "prompt", input: WAKE_PROMPT },
    { type: "prompt", input: "echoed from UI" },
    { type: "prompt", input: "echoed from peer inbox" },
    { type: "prompt", input: "echoed from broadcast" },
    { type: "text", output: "agent reply in activity" },
  ]), 8);

  const ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const open = (query) => sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));
  const next = async (stream, name) => {
    for (;;) {
      const { value, done } = await stream.next();
      if (done) return undefined;
      if (value.event === "problem") throw new Error(value.data.error);
      if (value.event === name) return value.data;
    }
  };

  const chat = await next(open(""), "state");
  assert.deepEqual(chat.messages.filter(m => m.terminal).map(m => [m.from, m.to, m.body]), [["operator", target, "typed in terminal"]], "project chat shows terminal prompts with their session");
  assert.equal(chat.messages.some(m => m.body === "echoed from UI" || m.body === "echoed from peer inbox"), false, "direct sends stay out of project chat");
  assert.deepEqual(chat.messages.filter(m => m.body === "echoed from broadcast").map(m => m.terminal), [undefined], "the broadcast shows once");

  const session = await next(open(`session=${encodeURIComponent(target)}`), "state");
  for (const state of [chat, session]) {
    assert.deepEqual(state.messages.filter(m => m.body === "Builder brief").map(m => [m.from, m.system, m.terminal]), [["system", true, undefined]]);
  }
  const terminal = session.messages.filter(m => m.terminal);
  assert.deepEqual(terminal.map(m => [m.from, m.to, m.body, m.kind]), [["operator", target, "typed in terminal", "Message"]]);
  assert.equal(terminal[0].receipt, undefined, "terminal prompts have no delivery ticks");
  assert.deepEqual(session.messages.filter(m => m.body === "echoed from UI").map(m => m.terminal), [undefined], "the UI message stays, the echo goes");
  const times = session.messages.map(m => m.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "messages stay in time order");
});
