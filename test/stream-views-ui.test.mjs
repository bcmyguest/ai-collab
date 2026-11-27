// The console's cache fed by real server frames: a screen switched back to shows its last view at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publishActivity } from "../lib/activity.ts";
import { approvalMessage } from "../lib/approvals.mjs";
import { broadcastTopic, loadConfig } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";
import { publish } from "../lib/transport.mjs";
import { createStreamViews } from "../web/lib/stream-views.js";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";

// One stream's frames through the cache until done() says to stop; returns the last view it rendered.
async function collect(stream, send, done) {
  let view;
  for await (const { event, data } of stream) {
    if (event === "problem") throw new Error(data.error);
    view = send(event, data) ?? view;
    if (done(event, data)) break;
  }
  return view;
}

test("both screens cache from real frames, and a switch back renders each at once", { timeout: 15000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const carol = { ...loadConfig(peerEnv(fake, { peer: "carol" })), session: "0000000000000003" };
  await publishActivity(bob, "claude", [{ type: "tool_call", tool: "Bash", input: { command: "ls" }, callId: "t1" }]);
  await sendMessage(bob, "all", "first line of the project chat");
  const approval = approvalMessage(cfg, "claude", { tool: "Bash", summary: "rm -rf build" }, { id: "0123456789ab", expiresAt: Date.now() + 60_000 });
  await publish(cfg, broadcastTopic(cfg.project), approval);

  const ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const open = query => sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));

  const views = createStreamViews();
  const chat = "project=demo";
  const timeline = `project=demo&session=${encodeURIComponent(`bob#${bob.session}`)}&view=activity`;
  let surfaces = 0;
  const chatSend = views.connect(chat);
  const chatView = await collect(open(chat), (event, data) => {
    if (event === "surface") surfaces += 1;
    return chatSend(event, data);
  }, event => event === "state");
  assert.equal(surfaces, 1, "the chat's approval card is a surface frame, and it comes before the state frame");
  // The approval rides the chat as its card's message too; the body is the tool summary.
  assert.deepEqual(chatView.data.messages.map(message => message.body), ["first line of the project chat", "rm -rf build"]);
  assert.ok(chatView.surfaces["approval-0123456789ab"]?.length > 0, "the surface is cached with the chat's view");

  // The timeline is a different stream, so it replaces the approval card with its own (absent) surfaces.
  const send = views.connect(timeline);
  const timelineView = await collect(open(timeline), send, (event, data) => event === "activity" && data.reset);
  assert.equal(timelineView.data.view.session, `bob#${bob.session}`);
  assert.deepEqual(timelineView.activity.map(row => [row.agent, row.type, row.tool]), [[`bob#${bob.session}`, "tool_call", "Bash"]]);
  assert.deepEqual(timelineView.surfaces, {}, "the timeline shows no approval card");

  // Both screens are cached, each with its own data, rows and surfaces.
  assert.deepEqual(views.restore(chat).data.messages.map(message => message.body), ["first line of the project chat", "rm -rf build"]);
  assert.deepEqual(views.restore(chat).surfaces, chatView.surfaces);
  assert.deepEqual(views.restore(timeline).activity, timelineView.activity);

  // A message arrives while the operator is on the timeline; the chat's cached view stands until its stream reconnects.
  await sendMessage(carol, "all", "carol while away");
  assert.deepEqual(views.restore(chat).data.messages.map(message => message.body), ["first line of the project chat", "rm -rf build"], "still the view last seen");
  const reconnect = views.connect(chat);
  // The stream's first state frame is the state as it loads, and a later one adds what arrived while away.
  const refreshed = await collect(open(chat), reconnect, (event, data) => event === "state" && data.messages.some(message => message.body === "carol while away"));
  assert.deepEqual(refreshed.data.messages.map(message => message.body), ["first line of the project chat", "rm -rf build", "carol while away"]);
});
