// Who receives a thread-channel post (docs/threads.md "Who receives a post"): the rule table, then recipients over a channel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { delivered, listens, threadRole } from "../lib/thread-listening.ts";
import { channelRecipients } from "../lib/thread-channels.ts";

// role, member, setting, mentioned → delivered; one row per line of the docs table.
const TABLE = [
  ["cooperative", true, null, false, true],
  ["cooperative", true, null, true, true],
  ["cooperative", true, false, false, false],
  ["cooperative", true, false, true, true],
  ["cooperative", true, true, false, true],
  ["cooperative", false, null, false, false],
  ["cooperative", false, null, true, true],
  ["cooperative", false, true, false, true],
  ["cooperative", false, false, true, true],
  ["subagent", true, null, false, false],
  ["subagent", true, null, true, true],
  ["subagent", true, true, false, true],
  ["subagent", true, false, true, true],
  ["subagent", false, null, false, false],
  ["subagent", false, null, true, true],
  ["subagent", false, true, false, true],
];

const at = (peer, n) => `${peer}#${String(n).padStart(16, "0")}`;
const LEAD = at("claude", 1);
const CHILD = at("codex", 2);
const MUTED = at("cursor", 3);
const OUTSIDER = at("claude", 4);
const OPTED = at("opencode", 5);
const GONE = at("pi", 6);

test("the delivery table: a mention always delivers, else the setting, else cooperative members only", () => {
  for (const [role, member, listening, mentioned, want] of TABLE) {
    assert.equal(delivered({ role, member, listening, mentioned }), want, JSON.stringify({ role, member, listening, mentioned }));
  }
  assert.equal(threadRole("claude#0000000000000001"), "subagent");
  assert.equal(threadRole(undefined), "cooperative");
  assert.equal(threadRole(""), "cooperative");
  assert.equal(listens({ role: "subagent", member: true }), false);
});

test("recipients: listeners, mentions by full address, never the sender or an unknown session", () => {
  const channel = {
    thread: { id: "th_00000000000000a1", project: "demo", title: "t", leadSession: LEAD },
    sessions: [
      { session: LEAD, member: true, listening: null },
      { session: CHILD, member: true, listening: null },
      { session: MUTED, member: true, listening: false },
      { session: OPTED, member: false, listening: true },
      { session: GONE, member: true, listening: null },
    ],
  };
  const sessions = [LEAD, CHILD, MUTED, OUTSIDER, OPTED].map(id => ({ id, ...(id === CHILD ? { parent: LEAD } : {}) }));
  const of = (body, sender = "operator") => channelRecipients(channel, { sessions, body, sender });
  assert.deepEqual(of("hello"), [LEAD, OPTED]);
  assert.deepEqual(of("hello", LEAD), [OPTED]);
  assert.deepEqual(of("hello @codex and @cursor"), [LEAD, CHILD, MUTED, OPTED]);
  // A non-member answers only to its full address; a bare @claude reaches the member lead, not the outsider.
  assert.deepEqual(of("hello @claude"), [LEAD, OPTED]);
  assert.deepEqual(of(`hello @${OUTSIDER}`), [LEAD, OPTED, OUTSIDER]);
  // The registry decides parentage when the list carries none, through the owned records.
  assert.deepEqual(channelRecipients(channel, { sessions: sessions.map(({ id }) => ({ id })), owned: [{ address: CHILD, parent: LEAD }], body: "x" }), [LEAD, OPTED]);
});
