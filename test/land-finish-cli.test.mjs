import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { land } from "../lib/land-cli.ts";
import { tempDir } from "./helpers/tmp.mjs";

function io() {
  const out = [];
  const err = [];
  return { out: { write: s => out.push(s) }, err: { write: s => err.push(s) }, text: () => ({ out: out.join(""), err: err.join("") }) };
}

// GitLab origin, so the default policy falls back to the packet path.
function fakeRun(calls) {
  return async (file, argv) => {
    calls.push([file, ...argv]);
    if (argv[0] === "remote") return { status: 0, stdout: "git@gitlab.com:o/r.git\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("land finish needs --proof unless --landing branch", async () => {
  const calls = [];
  const s = io();
  assert.equal(await land(["finish", "feat/x"], { ...s, run: fakeRun(calls) }), 1);
  assert.match(s.text().err, /finish needs --proof <file> unless --landing branch/);
  assert.deepEqual(calls, []);
});

test("land finish --landing branch pushes only the branch", async () => {
  const calls = [];
  const s = io();
  assert.equal(await land(["finish", "feat/x", "--landing", "branch"], { ...s, run: fakeRun(calls) }), 0);
  assert.equal(s.text().out, "branch: pushed feat/x\n");
  assert.deepEqual(calls, [["git", "push", "origin", "refs/heads/feat/x:refs/heads/feat/x"]]);
});

test("land finish refuses the packet path without a project and an unknown flag", async (t) => {
  const proof = join(tempDir(t, "land-finish-cli-"), "proof.txt");
  writeFileSync(proof, "npm test\nok\n");
  const s = io();
  assert.equal(await land(["finish", "feat/x", "--proof", proof], { ...s, run: fakeRun([]) }), 1);
  assert.match(s.text().err, /packet landing needs a project task board/);
  const u = io();
  assert.equal(await land(["finish", "feat/x", "--force", "1"], { ...u, run: fakeRun([]) }), 1);
  assert.match(u.text().err, /Usage: ai-collab land finish/);
});
