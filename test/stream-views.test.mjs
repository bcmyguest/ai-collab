// A screen switched back to renders the last view its stream sent, so a switch never waits for a state frame.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_MAX, createStreamViews, mergeActivity, streamViews } from "../web/lib/stream-views.js";

const row = id => ({ id, type: "tool_call" });
const snapshot = name => ({ project: "demo", view: { session: name }, messages: [{ id: "m-" + name }] });

test("surfaces arrive before the state frame; a stream renders nothing until its state arrives", () => {
  const views = createStreamViews();
  const send = views.connect("demo|session");
  assert.equal(send("surface", { id: "approval-1", operations: [{ beginRendering: {} }] }), undefined, "no state yet");
  assert.equal(send("activity", { reset: true, items: [row("a")] }), undefined, "no state yet");
  assert.equal(views.restore("demo|session"), undefined, "nothing cached before the first state");

  const view = send("state", snapshot("claude#1"));
  assert.deepEqual(view, {
    data: snapshot("claude#1"),
    activity: [row("a")],
    surfaces: { "approval-1": [{ beginRendering: {} }] },
  });
  assert.deepEqual(views.restore("demo|session"), view, "the state frame caches everything that came before it");
});

test("activity resets replace the rows, appends follow them, and the newest 500 stay", () => {
  assert.deepEqual(mergeActivity([row("a")], { reset: true, items: [row("b")] }), [row("b")]);
  assert.deepEqual(mergeActivity([row("a")], { reset: false, items: [row("b"), row("c")] }), [row("a"), row("b"), row("c")]);
  const full = Array.from({ length: ACTIVITY_MAX }, (_, i) => row(String(i)));
  const appended = mergeActivity(full, { reset: false, items: [row("last")] });
  assert.equal(appended.length, ACTIVITY_MAX);
  assert.equal(appended.at(-1).id, "last");
  assert.equal(appended[0].id, "1", "the oldest row dropped");
  assert.equal(mergeActivity([], { reset: true, items: full }).length, ACTIVITY_MAX, "a long reset is trimmed too");
});

test("a stream keeps its own data, activity and surfaces", () => {
  const views = createStreamViews();
  const chat = views.connect("demo|");
  const session = views.connect("demo|claude#1");
  chat("surface", { id: "s-chat", operations: [{ id: "chat" }] });
  session("surface", { id: "s-session", operations: [{ id: "session" }] });
  chat("state", snapshot("chat"));
  session("state", snapshot("session"));
  assert.deepEqual(views.restore("demo|").data, snapshot("chat"));
  assert.deepEqual(Object.keys(views.restore("demo|").surfaces), ["s-chat"]);
  assert.deepEqual(views.restore("demo|claude#1").data, snapshot("session"));
  assert.deepEqual(Object.keys(views.restore("demo|claude#1").surfaces), ["s-session"]);
});

test("switching back renders the cached view at once, and the reconnected stream replaces it", () => {
  const views = createStreamViews();
  const first = views.connect("demo|claude#1");
  first("state", snapshot("claude#1"));
  first("activity", { reset: true, items: [row("a"), row("b")] });

  // Away to another screen, then back: the old view is there before any frame of the new stream.
  views.connect("demo|codex#2")("state", snapshot("codex#2"));
  const restored = views.restore("demo|claude#1");
  assert.deepEqual(restored.data, snapshot("claude#1"));
  assert.deepEqual(restored.activity.map(item => item.id), ["a", "b"]);

  // The reconnected stream keeps that view on screen and updates it in place.
  const again = views.connect("demo|claude#1");
  // A surface for a card the cached view already shows is a live update, so it re-renders the cached view.
  assert.deepEqual(again("surface", { id: "approval-1", operations: [{ id: "allowed" }] }).surfaces, { "approval-1": [{ id: "allowed" }] });
  assert.deepEqual(again("activity", { reset: false, items: [row("c")] }).activity.map(item => item.id), ["a", "b", "c"], "new rows join the cached ones");
  const fresh = again("state", snapshot("claude#1"));
  assert.deepEqual(fresh.data, snapshot("claude#1"));
  assert.deepEqual(fresh.surfaces, { "approval-1": [{ id: "allowed" }] }, "the surfaces of the cached screen survive");
  // The server sends a full reset after the state frame, so rows read while away are not duplicated.
  again("activity", { reset: true, items: [row("a"), row("b"), row("c")] });
  assert.deepEqual(views.restore("demo|claude#1").activity.map(item => item.id), ["a", "b", "c"]);
});

test("the newest six screens stay cached, and reading one keeps it", () => {
  const views = createStreamViews(6);
  for (let i = 0; i < 6; i++) views.connect("k" + i)("state", snapshot("s" + i));
  assert.equal(views.restore("k0").data.view.session, "s0", "a read keeps k0");
  views.connect("k6")("state", snapshot("s6"));
  assert.equal(views.restore("k1"), undefined, "the least recently used screen was dropped");
  assert.equal(views.restore("k0").data.view.session, "s0");
  assert.equal(views.restore("k6").data.view.session, "s6");
});

test("a stream that never reached a state frame caches nothing", () => {
  const views = createStreamViews();
  const send = views.connect("k");
  send("surface", { id: "s", operations: [] });
  send("problem", { error: "ntfy unreachable" });
  assert.equal(views.restore("k"), undefined);
});

test("the console shares one cache, empty until a stream reports a state", () => {
  assert.equal(typeof streamViews.restore, "function");
  assert.equal(typeof streamViews.connect, "function");
  assert.equal(streamViews.restore("never connected"), undefined);
});

test("the console wires the cache: a stream builds it, a switch restores it, nothing renders from it before a state", async () => {
  const { readFileSync } = await import("node:fs");
  const chat = readFileSync(new URL("../web/app/chat.jsx", import.meta.url), "utf8");
  assert.match(chat, /import \{ streamViews \} from "@\/lib\/stream-views";/);
  assert.match(chat, /useState\(\(\) => streamViews\.restore\(streamOf\(selected\)\.requested\)\)/, "a first render opens the cached view");
  assert.match(chat, /const view = streamViews\.restore\(nextStream\);/, "a switch restores the screen it lands on");
  assert.match(chat, /const view = streamViews\.connect\(requested\);/, "each stream keeps its screen's view");
  // The cache is the one source for all three, so a reconnected stream replaces the whole screen rather than patching it.
  assert.match(chat, /setData\(next\.data\); setActivity\(next\.activity\); setSurfaces\(next\.surfaces\);/);
  assert.doesNotMatch(chat, /ACTIVITY_MAX/, "activity trimming lives in stream-views, not the console");
});

