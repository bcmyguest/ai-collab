import assert from "node:assert/strict";
import { test } from "node:test";
import { publishActivity } from "../lib/activity.ts";
import { askQuestion } from "../lib/questions.ts";
import { broadcastTopic, loadConfig } from "../lib/config.ts";
import { publish } from "../lib/messaging.ts";
import { sendMessage } from "../lib/messaging.ts";
import { createUi } from "../web/server/ui.ts";
import { answerMessage, answerText, terminalMessages } from "../web/lib/operator-messages.js";
import { peerEnv } from "./helpers/env.mjs";

// A wake run's env hides operator prompts from chat; tests run outside it.
delete process.env.AI_COLLAB_WAKE;
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8798";

test("terminal prompts drop echoes to the same target, the peer or all, within the window", () => {
  const prompts = [
    { id: "a", time: 100, agent: "bob#0000000000000001", input: "to all" },
    { id: "b", time: 100, agent: "bob#0000000000000001", input: "to bob" },
    { id: "c", time: 100, agent: "bob#0000000000000002", input: "other session" },
    { id: "d", time: 100, agent: "bob#0000000000000001", input: "old" },
  ];
  const sent = [
    { from: "operator", to: "all", body: "to all", time: 99 },
    { from: "operator", to: "bob", body: "to bob", time: 99 },
    { from: "operator", to: "bob#0000000000000001", body: "other session", time: 99 },
    { from: "operator", to: "all", body: "old", time: 100 - 301 },
    { from: "ntfy", to: "all", body: "to all", time: 99 },
  ];
  assert.deepEqual(terminalMessages(prompts, sent).map(m => [m.id, m.to, m.body, m.terminal, m.kind]), [
    ["c", "bob#0000000000000002", "other session", true, "Message"],
    ["d", "bob#0000000000000001", "old", true, "Message"],
  ]);
});

test("answer text is the choice labels, the decision, or the typed reply", () => {
  assert.equal(answerText(undefined, "postgres"), "postgres");
  assert.equal(answerText({ behavior: "allow" }, "yes"), "allow");
  assert.equal(answerText({ behavior: "allow", answers: { "Which db?": "postgres, redis" } }, "{}"), "postgres, redis");
});

test("an answer message is an operator message to the asker, linked by replyTo", () => {
  assert.deepEqual(answerMessage({ id: "e1", time: 5, asker: "bob#0000000000000001", question: "abcdef012345", body: "postgres", by: "octo" }), {
    id: "e1", time: 5, kind: "Message", sender: "operator", from: "operator", to: "bob#0000000000000001", body: "postgres", replyTo: "abcdef012345", by: "octo",
  });
});

test("project and session chats show terminal prompts and operator answers once", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const target = `bob#${bob.session}`;

  await publishActivity(bob, "claude", [{ type: "prompt", input: "typed in terminal" }]);
  const id = (await askQuestion(bob, "Which database?", { seconds: 0 })).id;
  await publish(cfg, broadcastTopic(cfg.project), `reply ${id} postgres`, { title: "Reply from operator" });

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

  const session = await next(open(`session=${encodeURIComponent(target)}`), "state");
  const answer = session.messages.filter(m => m.replyTo === id);
  assert.deepEqual(answer.map(m => [m.from, m.to, m.body, m.kind]), [["operator", target, "postgres", "Message"]]);
  assert.equal(session.messages.some(m => m.kind === "Reply"), false, "the ntfy reply entry is replaced by the answer message");
  assert.equal(session.messages.find(m => m.kind === "Question" && m.question === id)?.answer, "postgres", "the question still shows its answer");

  const chat = await next(open(""), "state");
  assert.deepEqual(chat.messages.filter(m => m.replyTo === id).map(m => [m.from, m.to, m.body]), [["operator", target, "postgres"]]);
  assert.deepEqual(chat.messages.filter(m => m.terminal).map(m => [m.from, m.to, m.body]), [["operator", target, "typed in terminal"]]);
});

test("a message the operator sent to all shows once in the project chat", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };

  await sendMessage(cfg, "all", "hello all");
  await publishActivity(bob, "claude", [{ type: "prompt", input: "hello all" }]);

  const ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
  let chat;
  for await (const { event, data } of stream) {
    if (event === "state") { chat = data; break; }
  }
  assert.equal(chat.messages.filter(m => m.body === "hello all").length, 1);
  assert.equal(chat.messages.some(m => m.terminal), false);
});
