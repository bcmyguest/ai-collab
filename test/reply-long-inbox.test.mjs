import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { replyToOperator, sendMessage } from "../lib/messaging.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

// About 300 KB of older direct messages: more than one bounded poll returns from the oldest end.
const OLDER = 100;
const FILLER = "x".repeat(3000);

test("an agent can reply to the newest operator message after a long day of direct messages", { timeout: 30_000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const operator = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const target = `bob#${bob.session}`;
  for (let i = 0; i < OLDER; i++) await sendMessage(operator, target, `${i} ${FILLER}`, { operatorThread: true });
  const latest = await sendMessage(operator, target, "newest question", { operatorThread: true });
  await replyToOperator(bob, latest.id, "answered");
});
