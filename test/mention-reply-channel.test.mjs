import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxTopic, loadConfig } from "../lib/config.mjs";
import { encodeEnvelope } from "../lib/agui.mjs";
import { replyToOperator, sendMessage } from "../lib/inbox.mjs";
import { publish } from "../lib/transport.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8798";

// Sends the operator message, has bob answer it, and returns the project and session chat messages.
async function chats(t, fields) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const target = `bob#${bob.session}`;
  const sent = await sendMessage(cfg, target, `@${target} status?`, { operatorThread: true, ...fields(target) });
  await replyToOperator(bob, sent.id, "all green");

  const ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const state = async (query) => {
    const stream = sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));
    for (;;) {
      const { value, done } = await stream.next();
      if (done) throw new Error("stream ended");
      if (value.event === "problem") throw new Error(value.data.error);
      if (value.event === "state") return value.data.messages.filter(m => m.body === "all green");
    }
  };
  return { target, project: await state(""), session: await state(`session=${encodeURIComponent(target)}`) };
}

test("an agent's reply to a project-chat mention shows in the project chat and once in the session chat", { timeout: 10000 }, async (t) => {
  const { target, project, session } = await chats(t, () => ({ mentionedIn: "all" }));
  assert.deepEqual(project.map(m => [m.from, m.to, m.quote?.body]), [[target, "operator", `@${target} status?`]]);
  assert.equal(session.length, 1, "the session chat shows the reply once");
});

test("a plain DM reply stays out of the project chat", { timeout: 10000 }, async (t) => {
  const { project, session } = await chats(t, () => ({}));
  assert.equal(project.length, 0);
  assert.equal(session.length, 1);
});

test("a reply to a project-chat mention from another session stays out of the project chat", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = `bob#0000000000000001`;
  const sent = await sendMessage(cfg, bob, `@${bob} status?`, { operatorThread: true, mentionedIn: "all" });
  // Carol's session answers bob's mention on the wire; replyToOperator only lets the addressed session reply.
  const carol = { ...loadConfig(peerEnv(fake, { peer: "carol" })), session: "0000000000000002" };
  const wire = encodeEnvelope("msg", { from: "carol", session: carol.session, to: "operator", operatorThread: true, replyTo: sent.id, ts: new Date().toISOString(), body: "all green" }, carol.wire);
  await publish(carol, inboxTopic(cfg.project, "carol"), wire, { title: "ai-collab from carol" });
  const ui = createUi({ cfg, env: peerEnv(fake, { peer: "operator" }) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const stream = sse(ui.events(new Request(`${base}/api/events?`, { signal: ctrl.signal })));
  for (;;) {
    const { value, done } = await stream.next();
    if (done) throw new Error("stream ended");
    if (value.event === "problem") throw new Error(value.data.error);
    if (value.event === "state") {
      assert.equal(value.data.messages.filter(m => m.body === "all green").length, 0);
      break;
    }
  }
});

test("a reply to a mention made in a session chat stays out of the project chat", { timeout: 10000 }, async (t) => {
  const { project, session } = await chats(t, target => ({ mentionedIn: target }));
  assert.equal(project.length, 0);
  assert.equal(session.length, 1);
});
