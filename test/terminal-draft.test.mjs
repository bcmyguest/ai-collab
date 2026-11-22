import assert from "node:assert/strict";
import { test } from "node:test";
import { paneHasDraft } from "../lib/terminal-draft.mjs";

test("terminal draft detection checks the matching pane's cursor row and ignores placeholders", () => {
  const tty = "/dev/pts/7";
  assert.equal(paneHasDraft("codex", tty, `${tty} 0 8 1\nold output\n› a draft\n`), true);
  assert.equal(paneHasDraft("claude", tty, `${tty} 0 8 0\n  ❯ a draft\n`), true);
  assert.equal(paneHasDraft("codex", tty, `${tty} 0 3 0\n›  Ask Codex\n`), false);
  assert.equal(paneHasDraft("codex", tty, `${tty} 0 8 1\n› old output\nworking…\n`), false);
  assert.equal(paneHasDraft("codex", tty, "/dev/pts/8 0 8 0\n› a draft\n"), false);
  assert.equal(paneHasDraft("codex", tty, `${tty} 1 8 0\n› a draft\n`), false);
});
