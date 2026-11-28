// The thread level in the hash (docs/threads.md "Thread view"): thread=<id> round-trips; a bad id falls back to the project chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSelection, selectionHash } from "../web/lib/selection.js";

const ID = "th_0123456789abcdef";

test("a thread selection round-trips through the hash", () => {
  const hash = selectionHash({ project: "demo", level: "thread", thread: ID });
  assert.equal(hash, `project=demo&level=thread&thread=${ID}`);
  const back = parseSelection(hash);
  assert.equal(back.level, "thread");
  assert.equal(back.thread, ID);
  assert.equal(back.project, "demo");
});

test("a thread hash with an invalid id opens the project chat", () => {
  assert.equal(parseSelection("project=demo&level=thread&thread=nope").level, "project");
  assert.equal(selectionHash({ project: "demo", level: "thread", thread: "nope" }), "project=demo&level=thread");
});
