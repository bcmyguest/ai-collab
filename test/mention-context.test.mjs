import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { formatInbox } from "../lib/format.ts";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

test("a routed @mention tells the tagged session which chat it came from", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const operator = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  await sendMessage(operator, `bob#${bob.session}`, "@bob#0000000000000001 run the merge", { operatorThread: true, mentionedIn: "alice#00000000000000aa" });
  await assert.rejects(sendMessage(operator, `bob#${bob.session}`, "x", { operatorThread: true, mentionedIn: "not a chat" }), /invalid mentionedIn/);
  const [message] = await claimInbox(bob);
  assert.equal(message.mentionedIn, "alice#00000000000000aa");
  assert.match(formatInbox([message], { session: bob.session }), /mentioned_in=alice#00000000000000aa/);
});
