import assert from "node:assert/strict";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { readAlertLevel } from "../lib/alerts.ts";
import { isAlertLevel, readRememberedAlertLevel, rememberAlertLevel, shownAlertLevel, subscriptionUsesKey } from "../web/lib/alert-level.js";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const tmp = () => tempDir({ after }, "ai-collab-alert-");

// The next state frame, or a plain failure: a level that is never pushed should fail the test, not hang it.
async function nextState(stream, ms = 3000) {
  let timer;
  const timeout = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`no state frame within ${ms}ms`)), ms); });
  try {
    return (await Promise.race([stream.next(), timeout])).value;
  } finally {
    clearTimeout(timer);
  }
}

// A config dir of its own, so the test never reads or writes the operator's real alerts.json.
const isolatedEnv = fake => ({ ...peerEnv(fake, { peer: "alice" }), XDG_CONFIG_HOME: tmp() });

test("a stored level shows as itself, and this browser's last choice covers the gap before the first state frame", () => {
  assert.equal(shownAlertLevel("questions", "none"), "questions", "the server file is the truth");
  assert.equal(shownAlertLevel(undefined, "questions-and-direct"), "questions-and-direct", "a reload shows the last choice");
  assert.equal(shownAlertLevel("", "none"), "none");
  assert.equal(shownAlertLevel(undefined, undefined), "all", "nothing remembered yet");
  assert.equal(shownAlertLevel("loud", "bogus"), "all", "an unknown level is no level");
  assert.equal(shownAlertLevel("loud", "none"), "none");
});

test("the last choice survives reloads through storage, and a broken storage does not throw", () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readRememberedAlertLevel(storage), undefined);
  rememberAlertLevel(storage, "questions");
  assert.equal(readRememberedAlertLevel(storage), "questions");
  rememberAlertLevel(storage, "loud");
  assert.equal(readRememberedAlertLevel(storage), "questions", "an unknown level is not stored");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
  assert.equal(readRememberedAlertLevel(broken), undefined);
  rememberAlertLevel(broken, "none");
  assert.equal(readRememberedAlertLevel(undefined), undefined);
});

test("a push subscription made with an older VAPID key is replaced, not trusted", () => {
  const key = new Uint8Array([1, 2, 3]);
  assert.equal(subscriptionUsesKey({ options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer } }, key), true);
  assert.equal(subscriptionUsesKey({ options: { applicationServerKey: new Uint8Array([9, 9, 9]).buffer } }, key), false);
  assert.equal(subscriptionUsesKey({ options: { applicationServerKey: new Uint8Array([1, 2]).buffer } }, key), false);
  assert.equal(subscriptionUsesKey({ options: {} }, key), true, "a browser that hides the key is assumed unchanged");
  assert.equal(subscriptionUsesKey({}, key), true);
  assert.equal(isAlertLevel("questions-only"), false);
  assert.equal(isAlertLevel("questions"), true);
});

test("setting the level writes it for every reader and pushes the new level to open tabs", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = isolatedEnv(fake);
  const cfg = loadConfig(env);
  const ui = createUi({ cfg, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });

  const stream = sse(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })));
  const first = (await nextState(stream)).data;
  assert.equal(first.alerts, "all", "the default before anything is stored");

  const post = level => ui.handle(new Request(`${base}/api/alerts`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", level }),
  }), "alerts");

  assert.equal((await post("questions")).status, 200);
  assert.equal(readAlertLevel(env), "questions", "the file every hook and the runner read now holds the level");
  const pushed = (await nextState(stream)).data;
  assert.equal(pushed.alerts, "questions", "an open tab learns the level at once, without waiting for a later message");

  assert.equal((await post("loud")).status, 400, "an unknown level is refused and changes nothing");
  assert.equal(readAlertLevel(env), "questions");

  // A new UI process (the deploy path) reads the same file, so the level is not lost across a rebuild.
  ui.close();
  const again = createUi({ cfg, env });
  t.after(() => again.close());
  const reopened = (await nextState(sse(again.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal }))))).data;
  assert.equal(reopened.alerts, "questions");
});
