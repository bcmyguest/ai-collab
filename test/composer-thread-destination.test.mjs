// In an open thread the composer posts to the thread channel (docs/threads.md "Thread channels"); @name still goes direct.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composerChannel, composerDestination, composerRecipients } from "../web/lib/message-routing.js";

const LEAD = "claude#598aed22aaaaaaaa";
const OTHER = "codex#1234567890abcdef";
const routing = {
  project: "demo", peers: ["claude", "codex"], tasks: [{ id: "t1", owner: OTHER }], teams: [], patterns: [], startable: [], models: {},
  agents: [
    { id: LEAD, peer: "claude", registered: true, identityName: "Lead", online: true },
    { id: OTHER, peer: "codex", registered: true, online: true },
  ],
  target: LEAD, thread: { id: "th_00000000000000a1", title: "UI redesign" },
};

test("a post in an open thread goes to everyone listening there, and an @mention adds a direct copy", () => {
  assert.equal(composerDestination({ ...routing, text: "hi" }), "Everyone listening in UI redesign");
  assert.equal(composerChannel({ ...routing, text: "hi" }), true);
  assert.deepEqual(composerRecipients({ ...routing, text: "hi" }), []);
  assert.equal(composerDestination({ ...routing, text: `hi @${OTHER}` }), "Everyone listening in UI redesign · Direct to codex#12345678");
  assert.deepEqual(composerRecipients({ ...routing, text: "hi @codex" }), [OTHER]);
});

test("a #task tag keeps its owner route, and without a thread the post stays direct", () => {
  assert.equal(composerChannel({ ...routing, text: "see #t1" }), false);
  assert.equal(composerDestination({ ...routing, text: "see #t1" }), "Direct to codex#12345678");
  assert.equal(composerDestination({ ...routing, thread: null, text: "hi" }), "Direct to Lead");
  assert.equal(composerChannel({ ...routing, hosted: true, text: "hi" }), false);
});
