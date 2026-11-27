// The composer names a direct recipient by its short session name and keeps the raw address for the hover title.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composerDestination, composerRecipients } from "../web/lib/message-routing.js";

const NAMED = "claude#598aed22aaaaaaaa";
const BARE = "codex#1234567890abcdef";
const routing = {
  project: "demo", peers: ["claude", "codex"], tasks: [], teams: [], patterns: [], startable: [], models: {},
  agents: [
    { id: NAMED, peer: "claude", registered: true, identityName: "Reviewer", name: "Review the PR" },
    { id: BARE, peer: "codex", registered: true },
  ],
};

test("a direct message names the session by its short name, else its short address", () => {
  assert.equal(composerDestination({ ...routing, text: "hi", target: NAMED }), "Direct to Reviewer");
  assert.equal(composerDestination({ ...routing, text: `hi @${BARE}`, target: "all" }), "Everyone in demo · Direct to codex#12345678");
  assert.equal(composerDestination({ ...routing, text: `hi @${NAMED}`, target: BARE }), "Direct to codex#12345678, Reviewer");
});

test("the raw addresses behind the destination stay available for its title", () => {
  assert.deepEqual(composerRecipients({ ...routing, text: `hi @${NAMED}`, target: BARE }), [BARE, NAMED]);
  assert.deepEqual(composerRecipients({ ...routing, text: "hi", target: "all" }), []);
});
