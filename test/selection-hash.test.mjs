import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSelection, selectionHash } from "../web/lib/selection.js";

// What a navigate() call writes must read back as the selection it was given; the patterns page depends on it for
// the author composer (author=1) and for the name the composer hands to the DOT editor (authorName).

test("home is a bare hash and a project chat keeps its project", () => {
  assert.equal(selectionHash({ level: "home" }), "home");
  assert.deepEqual(parseSelection(selectionHash({ project: "demo", level: "project" })), {
    project: "demo", level: "project", harness: "", session: "", tab: "chat", run: "",
  });
});

test("a session keeps its harness, session, tab and subagent run", () => {
  const next = { project: "demo", level: "session", harness: "claude", session: "claude#28d7fa48c0ffee01", tab: "subagents", run: "r9" };
  assert.deepEqual(parseSelection(selectionHash(next)), next);
  assert.equal(parseSelection(selectionHash({ ...next, tab: "raw", run: "" })).tab, "raw");
});

test("the patterns list, an inspected pattern and its raw text round-trip", () => {
  assert.equal(parseSelection(selectionHash({ project: "demo", level: "patterns" })).level, "patterns");
  const inspected = parseSelection(selectionHash({ project: "demo", level: "patterns", pattern: "fix-and-review", raw: "1" }));
  assert.equal(inspected.pattern, "fix-and-review");
  assert.equal(inspected.raw, true);
});

test("the author composer opens from the patterns page and survives the round trip", () => {
  // "Describe a team" hands over author:1 with no pattern: the composer drafts a new team.
  const fresh = parseSelection(selectionHash({ project: "demo", level: "patterns", author: "1" }));
  assert.equal(fresh.author, true);
  assert.equal(fresh.pattern, "");
  // "Refine with agent" names the pattern: the composer starts from that team.
  const refine = parseSelection(selectionHash({ project: "demo", level: "patterns", author: "1", pattern: "scout" }));
  assert.equal(refine.author, true);
  assert.equal(refine.pattern, "scout");
});

test("the name the composer hands to the DOT editor round-trips only with an editor open", () => {
  const editor = parseSelection(selectionHash({ project: "demo", level: "patterns", edit: "new", authorName: "scout" }));
  assert.equal(editor.edit, "new");
  assert.equal(editor.authorName, "scout");
  assert.equal(editor.author, undefined, "the editor is not the composer");
  // A name with no editor open would be a stale link; parseSelection drops it.
  assert.equal(parseSelection(selectionHash({ project: "demo", level: "patterns", authorName: "scout" })).authorName, undefined);
});
