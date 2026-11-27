import assert from "node:assert/strict";
import { test } from "node:test";
import { broadcastTopic, loadConfig } from "../lib/config.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";

test("history can search beyond the live window and retains read state after an offline restart", async t => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const topic = broadcastTopic(cfg.project);
  fake.inject(topic, "The original Needle message");
  for (let i = 0; i < 520; i++) fake.inject(topic, "More messages " + i);

  let ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const history = async (body, scope = "") => {
    const reply = await ui.handle(new Request(base + "/api/history?" + scope, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), "history");
    assert.equal(reply.status, 200);
    return reply.json();
  };

  const stream = sse(ui.events(new Request(base + "/api/events", { signal: ctrl.signal })));
  assert.equal((await stream.next()).value.data.messages.length, 100);
  assert.deepEqual((await history({ query: "needle" })).messages.map(item => item.body), ["The original Needle message"]);
  const page = await history({ query: "" });
  assert.equal(page.unread, 521);
  assert.equal(page.messages.length, 50);
  const older = await history({ query: "", before: page.next });
  assert.equal(older.messages.length, 50);
  assert.ok(older.messages.every(item => !page.messages.some(newer => newer.id === item.id)));
  assert.equal((await history({ query: "", read: page.latest })).unread, 0);

  ctrl.abort();
  ui.close();
  await fake.close();
  ui = createUi({ cfg, env });
  const offlineCtrl = new AbortController();
  t.after(() => offlineCtrl.abort());
  const offline = sse(ui.events(new Request(base + "/api/events?view=home", { signal: offlineCtrl.signal })));
  assert.equal((await offline.next()).value.data.project, cfg.project);
  const archived = await history({ query: "needle" });
  assert.equal(archived.messages.length, 1);
  assert.equal(archived.unread, 0);
  const harness = await history({ query: "needle" }, "harness=bob");
  assert.equal(harness.messages.length, 0);
});
