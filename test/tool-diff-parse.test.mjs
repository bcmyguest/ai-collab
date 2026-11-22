import assert from "node:assert/strict";
import { test } from "node:test";
import { toolDiff } from "../web/lib/tool-diff.js";

test("unified hunks count their lines, so a removed '-- comment' line stays in the hunk", () => {
  const patch = [
    "--- a/x.sql",
    "+++ b/x.sql",
    "@@ -1,3 +1,2 @@",
    "--- comment",
    "-old",
    "+new",
    " keep",
    "--- a/y.sql",
    "+++ b/y.sql",
    "@@ -1 +1 @@",
    "-p",
    "+q",
  ].join("\n");
  const files = toolDiff("apply_patch", JSON.stringify({ input: patch })).files;
  assert.deepEqual(files.map(file => [file.path, file.added, file.removed]), [["x.sql", 1, 2], ["y.sql", 1, 1]]);
  assert.deepEqual(files[0].hunks[0].lines.slice(0, 2), [{ t: "-", s: "-- comment" }, { t: "-", s: "old" }]);
});

test("an envelope's End Patch ends the patch, so a trailing newline adds no context line", () => {
  const plain = toolDiff("apply_patch", "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n").files[0];
  assert.equal(plain.hunks[0].lines.length, 2);
  const afterEof = toolDiff("apply_patch", "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End of File\n\n*** End Patch\n").files[0];
  assert.equal(afterEof.hunks[0].lines.length, 2);
  assert.equal(afterEof.hunks.length, 1);
});

test("a clipped Edit keeps its whole fields and says so", () => {
  const full = JSON.stringify({ file_path: "/a.js", old_string: "x", new_string: "y", replace_all: true }, null, 2);
  const cut = full.slice(0, full.indexOf("replace_all")) + "…[truncated 20 bytes]";
  const diff = toolDiff("Edit", cut);
  assert.equal(diff.truncated, true);
  assert.deepEqual([diff.files[0].added, diff.files[0].removed], [1, 1]);
  const inside = full.slice(0, full.indexOf("new_string") + 4) + "…[truncated 9 bytes]";
  assert.equal(toolDiff("Edit", inside), null, "an incomplete field is not shown");
});

test("a clipped apply_patch shows the part of its patch that survived the clip", () => {
  const patch = "*** Begin Patch\n*** Update File: src/app.js\n@@\n-  return x;\n+  return x + 1;\n*** End Patch";
  const full = JSON.stringify({ command: patch }, null, 2);
  const diff = toolDiff("apply_patch", full.slice(0, full.indexOf("return x + 1") + 6) + "…[truncated 40 bytes]");
  assert.equal(diff.truncated, true);
  assert.equal(diff.files[0].path, "src/app.js");
  assert.equal(diff.files[0].removed, 1);
});

test("Edit notes replace_all and a whitespace-only change; Write says written when the result says updated", () => {
  const all = toolDiff("Edit", JSON.stringify({ file_path: "/a", old_string: "x", new_string: "y", replace_all: true })).files[0];
  assert.deepEqual(all.notes, ["replace all occurrences"]);
  const space = toolDiff("Edit", JSON.stringify({ file_path: "/a", old_string: "a\n", new_string: "a" })).files[0];
  assert.deepEqual([space.hunks.length, space.notes], [0, ["whitespace or trailing newline only"]]);
  const content = JSON.stringify({ file_path: "/w", content: "hi" });
  assert.equal(toolDiff("Write", content, "The file /w has been updated successfully.").files[0].written, true);
  assert.equal(toolDiff("Write", content, "File created successfully at: /w").files[0].written, false);
});
