// Regression for the owner.json race TLC found in spec/tla/StoreLock.tla (OwnerWriteExclusive = FALSE).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, mock } from "node:test";
import { withLockSync } from "../lib/store.ts";
import { tempDir } from "./helpers/tmp.mjs";

const OTHER = { pid: process.pid, host: os.hostname(), token: "other-holder", start: null };

test("a process that stalls before writing owner.json does not take a lock another process retook", (t) => {
  const file = path.join(tempDir(t, "owner-race-"), "state.json");
  const lock = `${file}.lock`;
  const write = fs.writeFileSync;
  let stalled = false;
  // At the first owner write: a waiter broke the ownerless dir and another live process made and owns a new one.
  mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (!stalled && String(target).startsWith(path.join(lock, "owner.json"))) {
      stalled = true;
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
      write(path.join(lock, "owner.json"), JSON.stringify(OTHER));
    }
    return write(target, ...rest);
  });
  t.after(() => mock.restoreAll());

  const result = withLockSync(file, () => "entered", { waitMs: 100 });

  assert.equal(stalled, true);
  assert.deepEqual(result, { locked: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, "other-holder");
});
