import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { broadcastTopic, inboxTopic, loadConfig, sessionLabel } from "../lib/config.mjs";
import { parseEnvelope } from "../lib/inbox.mjs";
import { writeState } from "../lib/state.mjs";
import { openTasks } from "../lib/tasks.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const BASE = "http://127.0.0.1:8795";
const SESSION = "task-owner";
const LABEL = sessionLabel(SESSION);
const OWNER = `alice#${LABEL}`;

async function fixture(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(join(tmpdir(), "task-tags-ui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = peerEnv(fake, { peer: "operator", HOME: home, stateDir: join(home, "state"), XDG_DATA_HOME: join(home, "data") });
  const cfg = loadConfig(env);
  const tasks = openTasks(cfg.project, env);
  await tasks.add({ id: "owned-task", title: "Owned task" });
  await tasks.add({ id: "open-task", title: "Open task" });
  await tasks.add({ id: "other-task", title: "Other task" });
  await tasks.update("other-task", { owner: OWNER });
  writeState(join(cfg.stateDir, cfg.project, "registry", `${OWNER}.json`), { id: OWNER, sessionId: SESSION, cwd: home, harness: "alice", seenAt: Date.now() });
  const wakes = [];
  const ui = createUi({ cfg, env, control: async (action, session) => {
    wakes.push([action, session.id]);
    return { status: "requested" };
  } });
  t.after(() => ui.close());
  const send = (body, target = "all") => ui.handle(new Request(`${BASE}/api/send`, {
    method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ body, target }),
  }), "send");
  const messages = () => fake.state.publishes.flatMap(post => {
    const msg = parseEnvelope(post.message);
    return msg?.kind === "msg" ? [[post.topic, msg.operatorThread, msg.toSession, msg.body]] : [];
  });
  return { cfg, tasks, wakes, send, messages };
}

test("task tags reach the current owner once and wake its offline session", async t => {
  const { cfg, tasks, wakes, send, messages } = await fixture(t);
  await tasks.update("owned-task", { owner: OWNER });
  const body = `#owned-task and #other-task (#owned-task) @${OWNER}`;
  const res = await send(body);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).wake.status, "waking");
  assert.deepEqual(messages(), [[inboxTopic(cfg.project, "alice"), true, LABEL, body]]);
  assert.deepEqual(wakes, [["wake", OWNER]]);
});

test("an unowned task routes to project chat from a session composer", async t => {
  const { cfg, wakes, send, messages } = await fixture(t);
  const body = "Update (#open-task).";
  assert.equal((await send(body, OWNER)).status, 201);
  assert.deepEqual(messages(), [[broadcastTopic(cfg.project), undefined, undefined, body]]);
  assert.deepEqual(wakes, []);
});

test("unknown task tags and session address fragments preserve the selected recipient", async t => {
  const { cfg, send, messages } = await fixture(t);
  const body = "#owned-task-extra alice#owned-task";
  assert.equal((await send(body)).status, 201);
  assert.deepEqual(messages(), [[broadcastTopic(cfg.project), undefined, undefined, body]]);
});

test("a post tagging owned and unowned tasks sends one copy per destination", async t => {
  const { cfg, send, messages } = await fixture(t);
  const body = "#other-task #open-task #other-task";
  assert.equal((await send(body)).status, 201);
  assert.deepEqual(new Set(messages()), new Set([
    [broadcastTopic(cfg.project), undefined, undefined, body],
    [inboxTopic(cfg.project, "alice"), true, LABEL, body],
  ]));
});
