import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { formatInbox } from "../lib/format.ts";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { mentionedNames } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

test("mentionedNames keeps the @session/run form of a subagent tag", () => {
  const claude = "claude#28d7fa484e39f900";
  assert.deepEqual(
    mentionedNames(`@${claude}/ab0564f9df3a90bd4 and @codex#0123456789abcdef/x_Y-1.`, ["claude", "codex"]),
    [`${claude}/ab0564f9df3a90bd4`, "codex#0123456789abcdef/x_Y-1"],
  );
});

test("a message for a subagent run reaches its parent session with for_subagent", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const operator = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude,operator" }));
  const claude = { ...loadConfig(peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,operator" })), session: "28d7fa484e39f900" };
  await assert.rejects(sendMessage(operator, `claude#${claude.session}`, "x", { operatorThread: true, forSubagent: "bad run!" }), /invalid forSubagent/);
  await sendMessage(operator, `claude#${claude.session}`, "check the tests", { operatorThread: true, mentionedIn: "all", forSubagent: "ab0564f9df3a90bd4" });
  const [message] = await claimInbox(claude);
  assert.equal(message.forSubagent, "ab0564f9df3a90bd4");
  const text = formatInbox([message], { session: claude.session });
  assert.match(text, /for_subagent=ab0564f9df3a90bd4/);
  assert.match(text, /Relay this to that subagent \(Claude Code: SendMessage to ab0564f9df3a90bd4\)\./);
});
