import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readJson, updateJson, writeJson } from "../lib/store.ts";

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "ai-collab-store-"));
}

test("writeJson writes a 0600 file with a trailing newline and no temp left behind", () => {
  const dir = path.join(tempDir(), "nested");
  const file = path.join(dir, "state.json");
  writeJson(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("writeJson indents when asked", () => {
  const file = path.join(tempDir(), "indented.json");
  writeJson(file, { a: [1] }, { indent: 2 });
  assert.equal(readFileSync(file, "utf8"), '{\n  "a": [\n    1\n  ]\n}\n');
});

test("readJson returns undefined for a missing or corrupt file", () => {
  const dir = tempDir();
  assert.equal(readJson(path.join(dir, "missing.json")), undefined);
  writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.equal(readJson(path.join(dir, "bad.json")), undefined);
});

test("updateJson applies fn to the current value under the lock and returns the next", () => {
  const file = path.join(tempDir(), "counter.json");
  assert.deepEqual(updateJson(file, (current) => ({ n: (current?.n ?? 0) + 1 })), { n: 1 });
  assert.deepEqual(updateJson(file, (current) => ({ n: (current?.n ?? 0) + 1 })), { n: 2 });
  assert.equal(readJson(file)?.n, 2);
});

test("updateJson throws when the lock stays busy and leaves the file unchanged", () => {
  const file = path.join(tempDir(), "busy.json");
  writeJson(file, { n: 0 });
  mkdirSync(`${file}.lock`);
  assert.throws(() => updateJson(file, () => ({ n: 1 }), { waitMs: 50 }), /is busy; retry/);
  assert.equal(readJson(file)?.n, 0);
});
