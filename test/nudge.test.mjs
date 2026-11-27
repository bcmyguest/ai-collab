import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSession } from "../lib/sessions.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, publishStatus, releaseDelivery, reserveDelivery, reservedMessage, sendMessage, urgentSince } from "../lib/inbox.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

test("Send now on a queued message marks it urgent for that session's next hook", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  // Peers on one machine share a state dir; the marker lives there.
  const stateDir = tempDir(t, "ai-collab-state-");
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", stateDir }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob", stateDir })), session: "0000000000000001" };
  await publishStatus(bob, { event: "start", harness: "codex" });
  const ui = createUi({ cfg });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/nudge`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "nudge");

  const before = Date.now() - 1;
  assert.equal(urgentSince(bob, before), false);
  assert.equal((await post({ target: `bob#${bob.session}` })).status, 200);
  assert.equal(urgentSince(bob, before), true);
  assert.equal((await post({ target: "all" })).status, 400, "only a session address can be nudged");
});

test("queue actions change one pending message and respect delivery reservations", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = tempDir(t, "ai-collab-state-");
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", stateDir }));
  const operator = { ...cfg, peer: "operator" };
  const bob = { ...cfg, peer: "bob", session: sessionLabel("test-session") };
  await recordSession(bob, { id: "test-session", cwd: stateDir, harness: "codex", event: "start" });
  const target = `bob#${bob.session}`;
  const first = await sendMessage(operator, target, "original", { operatorThread: true });
  const second = await sendMessage(operator, target, "discard", { operatorThread: true });
  const third = await sendMessage(operator, target, "unchanged", { operatorThread: true });
  const control = t.mock.fn(async () => ({ status: "failed", detail: "Wake failed" }));
  const ui = createUi({ cfg, control });
  t.after(() => ui.close());
  const change = (id, queueAction, body) => ui.handle(new Request(`${base}/api/queue`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ target, id, queueAction, body }),
  }), "queue");

  async function snapshot() {
    const ctrl = new AbortController();
    const stream = sse(ui.events(new Request(`${base}/api/events?session=${encodeURIComponent(target)}`, { signal: ctrl.signal })));
    try { return (await stream.next()).value.data.messages; }
    finally { ctrl.abort(); }
  }
  assert.deepEqual((await snapshot()).filter(m => m.queued).map(m => m.id), [first.id, second.id, third.id]);

  const [peeked] = await claimInbox(bob, { commit: false, strict: true });
  assert.deepEqual(await reserveDelivery(bob, [first.id]), [first.id]);
  assert.equal((await change(first.id, "edit", "too early")).status, 409);
  await releaseDelivery(bob, [first.id]);
  assert.equal((await change(first.id, "edit", "edited")).status, 200);
  const retry = await change(first.id, "steer");
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, "waking");
  assert.equal(control.mock.callCount(), 1);
  assert.equal(control.mock.calls[0].arguments[0], "wake");
  assert.equal(control.mock.calls[0].arguments[1].id, target);
  assert.equal((await change(first.id, "steer")).status, 200);
  assert.equal(control.mock.callCount(), 2, "a failed wake can be retried");
  assert.equal((await change(second.id, "cancel")).status, 200);
  assert.deepEqual(await reserveDelivery(bob, [second.id]), []);
  assert.equal(reservedMessage(bob, peeked).body, "edited");
  assert.deepEqual((await snapshot()).filter(m => m.queued).map(m => m.body), ["edited", "unchanged"]);
  const delivered = await claimInbox(bob, { strict: true });
  assert.deepEqual(delivered.map(({ id, body, urgent }) => [id, body, urgent]), [
    [first.id, "edited", true],
    [third.id, "unchanged", undefined],
  ]);
  assert.equal((await change(first.id, "cancel")).status, 409);
  const finished = await snapshot();
  assert.equal(finished.some(m => m.queued), false);
  assert.equal(finished.find(m => m.id === second.id).queueStatus, "Canceled");
  assert.equal(finished.find(m => m.id === first.id).queueStatus, "Claimed for delivery");
});
