import assert from "node:assert/strict";
import { test } from "node:test";
import { DIFF_MAX_LINES, limitFiles, patchOf, toolDiff } from "../web/lib/tool-diff.js";

const edit = (input) => JSON.stringify(input);

test("Edit becomes one file with old and new text as removed and added lines", () => {
  const diff = toolDiff("Edit", edit({ file_path: "/src/app.js", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;\nconst c = 4;" }));
  assert.equal(diff.files.length, 1);
  const [file] = diff.files;
  assert.equal(file.path, "/src/app.js");
  assert.equal(file.kind, "update");
  assert.equal(file.added, 2);
  assert.equal(file.removed, 1);
  assert.equal(patchOf(file), [
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
  ].join("\n"));
});

test("an Edit that changes nothing has no changed lines", () => {
  const diff = toolDiff("Edit", edit({ file_path: "/a.txt", old_string: "same", new_string: "same" }));
  assert.deepEqual([diff.files[0].added, diff.files[0].removed, diff.files[0].hunks.length], [0, 0, 0]);
});

test("Edit keeps at most three context lines on each side of a change", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const oldText = lines.join("\n");
  const newText = lines.map((line, i) => (i === 5 ? "changed" : line)).join("\n");
  const [file] = toolDiff("Edit", edit({ file_path: "/f", old_string: oldText, new_string: newText })).files;
  assert.deepEqual(file.hunks[0].lines.map(line => line.t + line.s), [" line 2", " line 3", " line 4", "-line 5", "+changed", " line 7", " line 8", " line 9"]);
});

test("MultiEdit gives one hunk per edit in one file", () => {
  const diff = toolDiff("MultiEdit", edit({ file_path: "/x.ts", edits: [
    { old_string: "a", new_string: "b" },
    { old_string: "c", new_string: "d\ne" },
  ] }));
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].hunks.length, 2);
  assert.deepEqual([diff.files[0].added, diff.files[0].removed], [3, 2]);
});

test("Write becomes a new file with every line added", () => {
  const diff = toolDiff("Write", edit({ file_path: "/new.md", content: "# Title\nbody\n" }));
  const [file] = diff.files;
  assert.equal(file.kind, "add");
  assert.deepEqual([file.added, file.removed], [2, 0]);
  assert.equal(patchOf(file).split("\n").slice(0, 3).join("\n"), "--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@");
});

test("apply_patch with the Codex envelope gives update, add and delete files", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.js",
    "@@ function f() {",
    " keep",
    "-old line",
    "+new line",
    "*** Add File: src/b.js",
    "+one",
    "+two",
    "*** Delete File: src/c.js",
    "*** End Patch",
  ].join("\n");
  const diff = toolDiff("apply_patch", JSON.stringify({ command: patch }));
  assert.deepEqual(diff.files.map(file => [file.path, file.kind, file.added, file.removed]), [
    ["src/a.js", "update", 1, 1],
    ["src/b.js", "add", 2, 0],
    ["src/c.js", "delete", 0, 0],
  ]);
  assert.equal(patchOf(diff.files[0]).split("\n")[2], "@@ -1,2 +1,2 @@");
});

test("apply_patch with a bare string or an array command reads the patch text", () => {
  const patch = "*** Begin Patch\n*** Add File: n.txt\n+hi\n*** End Patch";
  assert.equal(toolDiff("apply_patch", patch).files[0].added, 1);
  assert.equal(toolDiff("apply_patch", JSON.stringify({ command: ["apply_patch", patch] })).files[0].path, "n.txt");
});

test("apply_patch with a unified diff reads each file from its headers", () => {
  const patch = [
    "diff --git a/x.js b/x.js",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/y.js b/y.js",
    "--- a/y.js",
    "+++ b/y.js",
    "@@ -1 +1,2 @@",
    " k",
    "+m",
  ].join("\n");
  const diff = toolDiff("apply_patch", JSON.stringify({ input: patch }));
  assert.deepEqual(diff.files.map(file => [file.path, file.added, file.removed]), [["x.js", 1, 1], ["y.js", 1, 0]]);
});

test("inputs that are not file edits return null and keep today's rendering", () => {
  assert.equal(toolDiff("Bash", edit({ command: "ls" })), null);
  assert.equal(toolDiff("Edit", edit({ file_path: "/a", old_string: "x" })), null, "missing new_string");
  assert.equal(toolDiff("Edit", "{\"file_path\":\"/a\",\"old_st"), null, "truncated JSON");
  assert.equal(toolDiff("MultiEdit", edit({ file_path: "/a", edits: [] })), null, "no edits");
  assert.equal(toolDiff("apply_patch", "just some words"), null);
  assert.equal(toolDiff("Edit", undefined), null);
});

test("limitFiles shows at most DIFF_MAX_LINES lines and counts the rest as hidden", () => {
  const content = Array.from({ length: DIFF_MAX_LINES + 100 }, (_, i) => `row ${i}`).join("\n");
  const [file] = toolDiff("Write", edit({ file_path: "/big.txt", content })).files;
  const { files, hidden } = limitFiles([file]);
  assert.equal(hidden, 100);
  assert.equal(files[0].hunks[0].lines.length, DIFF_MAX_LINES);
  assert.equal(file.added, DIFF_MAX_LINES + 100, "counts keep the full total");
  const header = patchOf(files[0]).split("\n")[2];
  assert.equal(header, `@@ -0,0 +1,${DIFF_MAX_LINES} @@`, "the truncated patch counts what it shows");
});

test("limitFiles leaves a diff under the limit whole", () => {
  const [file] = toolDiff("Edit", edit({ file_path: "/a", old_string: "x", new_string: "y" })).files;
  assert.deepEqual(limitFiles([file]), { files: [{ ...file, hunks: file.hunks }], hidden: 0 });
});
