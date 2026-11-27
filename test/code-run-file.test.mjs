// run_code can run a saved program: `file` instead of inline `code`, with an optional `input` value.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODE_MAX_CHARS, programSource } from "../lib/code-run.ts";
import { tempDir } from "./helpers/tmp.mjs";

function dirs() {
  const root = tempDir({ after }, "rc-file-");
  const cwd = path.join(root, "project");
  mkdirSync(path.join(cwd, "programs"), { recursive: true });
  return { root, cwd };
}

test("a .mjs file inside the working folder becomes the program, and input is bound before it", () => {
  const { cwd } = dirs();
  writeFileSync(path.join(cwd, "programs", "count.mjs"), "return (await ai.task_list({})).tasks.length + input.extra;");
  const source = programSource({ file: "programs/count.mjs", input: { extra: 2 } }, { cwd });
  assert.match(source, /^const input = \{"extra":2\};\n/);
  assert.match(source, /return \(await ai\.task_list/);
  assert.equal(programSource({ file: path.join(cwd, "programs", "count.mjs") }, { cwd }).startsWith("const input = undefined;\n"), true);
});

test("inline code still works, and input applies to it too", () => {
  assert.equal(programSource({ code: "return input;", input: [1] }, { cwd: "/" }), "const input = [1];\nreturn input;");
  assert.equal(programSource({ code: "return 1;" }, { cwd: "/" }), "return 1;");
});

test("exactly one of code and file is required", () => {
  const { cwd } = dirs();
  assert.throws(() => programSource({}, { cwd }), /exactly one of code or file/);
  writeFileSync(path.join(cwd, "a.js"), "return 1;");
  assert.throws(() => programSource({ code: "return 1;", file: "a.js" }, { cwd }), /exactly one of code or file/);
});

test("files outside the working folder, other extensions, symlinks out, missing and oversized files are refused", () => {
  const { root, cwd } = dirs();
  writeFileSync(path.join(root, "outside.mjs"), "return 1;");
  assert.throws(() => programSource({ file: "../outside.mjs" }, { cwd }), /inside/);
  assert.throws(() => programSource({ file: path.join(root, "outside.mjs") }, { cwd }), /inside/);
  symlinkSync(path.join(root, "outside.mjs"), path.join(cwd, "link.mjs"));
  assert.throws(() => programSource({ file: "link.mjs" }, { cwd }), /inside/);
  writeFileSync(path.join(cwd, "notes.txt"), "return 1;");
  assert.throws(() => programSource({ file: "notes.txt" }, { cwd }), /\.js or \.mjs/);
  assert.throws(() => programSource({ file: "missing.mjs" }, { cwd }), /cannot read/);
  writeFileSync(path.join(cwd, "big.mjs"), "x".repeat(CODE_MAX_CHARS + 1));
  assert.throws(() => programSource({ file: "big.mjs" }, { cwd }), /characters/);
});
