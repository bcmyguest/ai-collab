import assert from "node:assert/strict";
import { test } from "node:test";
import { withMentions } from "../web/lib/mentions.js";

test("a harness:model tag is highlighted whole", () => {
  assert.equal(withMentions("@codex:gpt-6.2-astra fix it"), "[@codex:gpt-6.2-astra](#mention) fix it");
  assert.equal(withMentions("try @codex:o3/mini_x-1 now"), "try [@codex:o3/mini_x-1](#mention) now");
});

test("a trailing full stop after a model tag is not part of it", () => {
  assert.equal(withMentions("ask @codex:gpt-6.2-astra."), "ask [@codex:gpt-6.2-astra](#mention).");
  assert.equal(withMentions("@codex:gpt-6.2-astra."), "[@codex:gpt-6.2-astra](#mention).");
});

test("a peer session tag with a subagent run is highlighted whole", () => {
  const tag = "@alice#0123456789abcdef/run_7-b";
  assert.equal(withMentions(`hand to ${tag}, then wait`), `hand to [${tag}](#mention), then wait`);
});

test("peer and session tags keep their existing highlight", () => {
  assert.equal(withMentions("@bob and @bob#0123456789abcdef."), "[@bob](#mention) and [@bob#0123456789abcdef](#mention).");
  assert.equal(withMentions("(@codex)"), "([@codex](#mention))");
});

test("text that is not a mention stays plain", () => {
  assert.equal(withMentions("mail a@codex.com"), "mail a@codex.com");
  assert.equal(withMentions("@Codex"), "@Codex");
  assert.equal(withMentions(undefined), "undefined");
});
