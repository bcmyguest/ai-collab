import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.ts";
import { claimInbox, sendMessage } from "../lib/messaging.ts";

const SESSION = "aabbccddeeff0123";
const OTHER = "0123456789abcdef";

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = (peer, extra = {}) => peerEnv(fake, { peer, ...extra });
  const alice = loadConfig(env("alice"));
  const bob = loadConfig(env("bob", { AI_COLLAB_SESSION: SESSION }));
  const operator = loadConfig(env("operator"));
  return { alice, bob, operator };
}

test("a broadcast with no mention is not claimed", async (t) => {
  const { alice, bob } = await setup(t);
  await sendMessage(alice, "all", "channel noise");
  await sendMessage(alice, `bob#${SESSION}`, "just you");
  assert.deepEqual((await claimInbox(bob)).map((m) => m.body), ["just you"]);
});

test("a direct message is claimed", async (t) => {
  const { alice, bob, operator } = await setup(t);
  await sendMessage(alice, "bob", "peer inbox");
  await sendMessage(alice, `bob#${SESSION}`, "this session");
  await sendMessage(operator, `bob#${SESSION}`, "from the operator", { operatorThread: true });
  assert.deepEqual((await claimInbox(bob)).map((m) => m.body), ["peer inbox", "this session", "from the operator"]);
});

test("a broadcast that mentions the session is claimed", async (t) => {
  const { alice, bob, operator } = await setup(t);
  await sendMessage(alice, "all", "no one in particular");
  await sendMessage(alice, "all", `@bob#${OTHER} the other session`);
  await sendMessage(alice, "all", `@bob#${SESSION} this session`);
  await sendMessage(operator, "all", `@bob#${SESSION} operator calling`);
  await sendMessage(alice, "all", "@bob the harness");
  assert.deepEqual((await claimInbox(bob)).map((m) => m.body), [
    `@bob#${SESSION} this session`,
    `@bob#${SESSION} operator calling`,
    "@bob the harness",
  ]);
});
