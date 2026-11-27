import { parseWireEnvelope } from "../lib/agui.mjs";
import { EventType } from "@ag-ui/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { broadcastTopic, inboxTopic, loadConfig, loadProjects, sessionLabel, statusTopic } from "../lib/config.mjs";
import { claimInbox, publishStatus, replyToOperator, sendMessage } from "../lib/inbox.mjs";
import { waitForAnswer } from "../lib/questions.ts";
import { recordSession } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

test("UI streams state, sends directly, rejects cross-origin posts, and answers questions", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const otherBob = { ...bob, session: "0000000000000002" };
  await publishStatus(bob, { event: "start", harness: "codex" });
  const allowedOrigin = "https://ai-collab-ui.example.test";
  const ui = createUi({ cfg, allowedOrigin });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const post = (action, body, origin = base) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), action);

  assert.equal((await post("messages", { target: "all", body: "blocked" }, "https://example.invalid")).status, 403);
  assert.equal((await post("unknown", { target: "all", body: "x" })).status, 404);
  assert.equal(ui.events(new Request(`${base}/api/events?project=bad%20name`)).status, 400);
  assert.equal(ui.events(new Request(`${base}/api/events?harness=mallory`)).status, 400);
  assert.equal(ui.events(new Request(`${base}/api/events?session=bob%23nothex`)).status, 400);

  const response = ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal }));
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const stream = sse(response);
  const first = (await stream.next()).value;
  assert.equal(first.type, EventType.STATE_SNAPSHOT);
  assert.ok(first.data.agents.some(agent => agent.id === `bob#${bob.session}`));
  assert.deepEqual(first.data.projects, [{ id: "demo", peers: ["alice", "bob", "carol"] }]);
  assert.deepEqual(first.data.harnesses.map(h => h.id), ["alice", "bob", "carol"]);

  assert.equal((await post("messages", { target: `bob#${bob.session}`, body: "direct" }, allowedOrigin)).status, 201);
  assert.deepEqual((await claimInbox(otherBob)).map(({ body }) => body), []);
  assert.deepEqual((await claimInbox(bob)).map(({ body }) => body), ["direct"]);

  assert.equal((await post("send", { target: "all", body: "pushed to the browser" })).status, 201);
  let pushed;
  for await (const { event, data } of stream) {
    if (event === "state" && data.messages.some(m => m.body === "pushed to the browser")) { pushed = data; break; }
  }
  assert.equal(pushed.messages.at(-1).from, "operator");

  const question = "123456789abc";
  assert.equal((await post("messages", { target: "all", body: "Approved", question })).status, 201);
  const answer = await waitForAnswer(bob, question, { seconds: 0 });
  assert.equal(answer.answer, "Approved");
});

test("UI zooms by sender and reports when each session last messaged", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const otherBob = { ...bob, session: "0000000000000002" };
  const carol = { ...loadConfig(peerEnv(fake, { peer: "carol" })), session: "0000000000000003" };
  await sendMessage(bob, "all", "bob to everyone");
  await sendMessage(carol, "all", "carol to everyone");
  await sendMessage(carol, "all", "heads up @bob");
  await sendMessage(carol, "bob", "carol to bob inbox");
  const ui = createUi({ cfg });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const open = query => sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));
  const post = (action, body) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), action);

  const project = (await open("project=demo").next()).value.data;
  assert.deepEqual(project.messages.map(m => m.body), ["bob to everyone", "carol to everyone", "heads up @bob"]);
  const harness = (await open("project=demo&harness=bob").next()).value.data;
  assert.deepEqual(harness.messages.map(m => m.body), ["bob to everyone", "heads up @bob", "carol to bob inbox"]);

  const target = `bob#${otherBob.session}`;
  assert.equal((await post("send", { project: "demo", target, body: "only you" })).status, 201);
  const [sent] = (await claimInbox(otherBob)).filter(m => m.body === "only you");
  await replyToOperator(otherBob, sent.id, "same thread");
  const stream = open(`project=demo&session=${encodeURIComponent(target)}`);
  let thread;
  for await (const { data } of stream) if (data.messages.length === 2) { thread = data; break; }
  assert.deepEqual(thread.messages.map(m => [m.from, m.body]), [["operator", "only you"], [target, "same thread"]]);
  assert.deepEqual(thread.view, { harness: "bob", session: target });

  const times = Object.fromEntries(thread.agents.map(a => [a.id, a.lastMessageAt]));
  assert.ok(times[target] >= times[`bob#${bob.session}`] && times[`bob#${bob.session}`] > 0);
  assert.ok(times[`carol#${carol.session}`] > 0);
  const byHarness = Object.fromEntries(thread.harnesses.map(h => [h.id, h.lastMessageAt]));
  assert.equal(byHarness.bob, times[target]);
  assert.equal(byHarness.alice, 0);
});

test("UI shares one ntfy subscription across projects and fetches each topic's history once", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  const other = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_PROJECT: "second", AI_COLLAB_PEERS: "dave" }));
  const topic = broadcastTopic(cfg.project);
  fake.inject(topic, "Existing topic history");
  const ui = createUi({ projects: [cfg, other] });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const open = query => sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));

  const [one, two] = [open("project=demo"), open("")];
  const states = [(await one.next()).value, (await two.next()).value];
  for (const { data } of states) assert.deepEqual(data.messages.map(m => m.body), ["Existing topic history"]);
  assert.deepEqual(states[0].data.projects.map(p => p.id), ["demo", "second"]);
  assert.equal(fake.state.polls.filter(poll => poll.topic === topic).length, 1);

  fake.inject(topic, "Live post");
  for (const stream of [one, two]) {
    const { data } = (await stream.next()).value;
    assert.deepEqual(data.messages.map(m => m.body), ["Existing topic history", "Live post"]);
  }
  assert.equal(fake.state.polls.filter(poll => poll.topic === topic).length, 1);
  const latest = fake.state.subscribes.at(-1);
  assert.ok(latest.topics.includes(topic) && latest.topics.includes(statusTopic(cfg.project)));
  assert.equal(fake.state.subscribes.length, 1);

  const second = (await open("project=second").next()).value.data;
  assert.equal(second.project, "second");
  assert.deepEqual(second.harnesses.map(h => h.id), ["dave"]);
  for (;;) {
    const names = fake.state.subscribes.at(-1).topics;
    if (names.includes(broadcastTopic("second"))) {
      assert.ok(names.includes(topic) && names.includes(inboxTopic("second", "dave")));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(fake.state.polls.filter(poll => poll.topic === topic).length, 1);
  assert.equal(ui.events(new Request(`${base}/api/events?project=missing`)).status, 400);
});

test("loadProjects reads every projects.json entry with its own settings", (t) => {
  const home = tempDir(t, "ai-collab-projects-");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root: "/srv/one", project: "one", url: "http://127.0.0.1:9001", peers: "claude,codex" },
    { root: "/srv/two", project: "two", url: "http://127.0.0.1:9002", peers: "cursor" },
    { root: "relative", project: "skipped" },
  ]));
  const list = loadProjects({ HOME: home, AI_COLLAB_PROJECT: "ignored", AI_COLLAB_PEERS: "x" }, { host: "operator" });
  assert.deepEqual(list.map(cfg => [cfg.project, cfg.url, cfg.peers, cfg.peer]), [
    ["one", "http://127.0.0.1:9001", ["claude", "codex"], "operator"],
    ["two", "http://127.0.0.1:9002", ["cursor"], "operator"],
  ]);
});

test("AFK mode publishes to every project, streams the latest mode, and stays out of the chat", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  const other = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_PROJECT: "second", AI_COLLAB_PEERS: "dave" }));
  const allowedOrigin = "https://ai-collab-ui.example.test";
  const ui = createUi({ projects: [cfg, other], allowedOrigin });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const post = (body, origin = base) => ui.handle(new Request(`${base}/api/afk`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "afk");

  const stream = sse(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })));
  assert.equal((await stream.next()).value.data.mode, "off");
  assert.equal((await post({ mode: "quiet" }, "https://example.invalid")).status, 403);
  assert.equal((await post({ mode: "away" })).status, 400);
  assert.equal(fake.state.publishes.length, 0);

  assert.equal((await post({ mode: "quiet" }, allowedOrigin)).status, 201);
  const sent = fake.state.publishes.map(p => [p.topic, parseWireEnvelope(p.message)]);
  assert.deepEqual(sent.map(([topic]) => topic).sort(), [broadcastTopic("demo"), broadcastTopic("second")]);
  for (const [, envelope] of sent) {
    assert.deepEqual({ ...envelope, ts: 0 }, { v: 1, kind: "mode", from: "operator", mode: "quiet", ts: 0 });
    assert.ok(Number.isInteger(envelope.ts) && envelope.ts > 0);
  }
  let state;
  for await (const { data } of stream) if (data.mode === "quiet") { state = data; break; }
  assert.deepEqual(state.messages, []);

  assert.equal((await post({ mode: "on" })).status, 201);
  for await (const { data } of stream) if (data.mode === "on") break;
});

test("a terminal draft holds a phone message until retry or explicit override", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  const id = "codex-draft-session";
  const bob = { ...cfg, peer: "bob", session: sessionLabel(id) };
  const target = `bob#${bob.session}`;
  await recordSession(bob, { id, cwd: process.cwd(), harness: "codex", event: "Stop" });
  let drafting = true;
  const ui = createUi({ cfg, hasDraft: session => session.id === target && drafting });
  t.after(() => ui.close());
  const post = (body, options) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ target, body, ...options }),
  }), "send");

  const held = await post("first", { urgent: true });
  assert.deepEqual(await held.json(), { sent: false, draftHeld: true });
  assert.deepEqual(await claimInbox(bob), []);
  assert.equal((await post("first", { urgent: true, sendAnyway: true })).status, 201);
  assert.deepEqual((await claimInbox(bob)).map(({ body, urgent }) => [body, urgent]), [["first", true]]);

  assert.equal((await (await post("second")).json()).draftHeld, true);
  drafting = false;
  assert.equal((await post("second")).status, 201);
  assert.deepEqual((await claimInbox(bob)).map(({ body }) => body), ["second"]);
});
