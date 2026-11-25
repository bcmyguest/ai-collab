import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { runStress } from "./helpers/lock-stress.mjs";
import { runStuck } from "./helpers/lock-stuck.mjs";

// STORE_IMPL points the suite at another store.ts, e.g. a scratch copy of an older commit.
const IMPL = process.env.STORE_IMPL ? path.resolve(process.env.STORE_IMPL) : fileURLToPath(new URL("../lib/store.ts", import.meta.url));
const OLD_LOCK = fileURLToPath(new URL("./helpers/old-state.mjs", import.meta.url));
const { readJson, updateJson, withLock, withLockSync, writeJson } = await import(pathToFileURL(IMPL).href);

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

function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

// Lock directory in the on-disk shape store.ts writes: owner.json holds pid, host and token.
function makeLock(file, owner, ageMs = 0) {
  const lock = `${file}.lock`;
  mkdirSync(lock);
  if (owner) writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ host: os.hostname(), token: "test", ...owner }));
  if (ageMs) {
    const past = (Date.now() - ageMs) / 1000;
    utimesSync(lock, past, past);
  }
  return lock;
}

test("a lock whose owner pid is dead is taken at once, not after staleMs", async () => {
  const file = path.join(tempDir(), "dead-owner.json");
  makeLock(file, { pid: deadPid() });
  const started = Date.now();
  const result = await withLock(file, async () => "ok");
  assert.deepEqual(result, { locked: true, value: "ok" });
  assert.ok(Date.now() - started < 1000, "waited for staleMs");
});

test("a lock held by a live pid is not broken before staleMs", async () => {
  const file = path.join(tempDir(), "live-owner.json");
  // 2 x staleMs: older than staleMs, younger than the 10 x staleMs ceiling.
  const lock = makeLock(file, { pid: process.pid }, 120_000);
  const result = await withLock(file, async () => "ok", { waitMs: 200, staleMs: 60_000 });
  assert.deepEqual(result, { locked: false });
  assert.ok(existsSync(lock));
});

test("a lock without an owner file is broken only once older than staleMs", () => {
  const dir = tempDir();
  const fresh = path.join(dir, "fresh.json");
  makeLock(fresh, null);
  assert.deepEqual(withLockSync(fresh, () => "ok", { waitMs: 100, staleMs: 60_000 }), { locked: false });
  const old = path.join(dir, "old.json");
  makeLock(old, null, 3_600_000);
  assert.deepEqual(withLockSync(old, () => "ok", { waitMs: 100, staleMs: 60_000 }), { locked: true, value: "ok" });
});

function runChild(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("two processes breaking one dead lock never both enter the critical section", async () => {
  const script = `
    import { withLock } from ${JSON.stringify(pathToFileURL(IMPL).href)};
    import { rmSync, writeFileSync } from "node:fs";
    const file = process.env.LOCK_FILE;
    const result = await withLock(file, async () => {
      writeFileSync(file + ".inside", "x", { flag: "wx" });
      await new Promise((r) => setTimeout(r, 200));
      rmSync(file + ".inside");
      return "done";
    }, { waitMs: 5000 });
    console.log(JSON.stringify(result));
  `;
  for (let round = 0; round < 5; round += 1) {
    const file = path.join(tempDir(), `race-${round}.json`);
    makeLock(file, { pid: deadPid() });
    const runs = await Promise.all([runChild(script, { LOCK_FILE: file }), runChild(script, { LOCK_FILE: file })]);
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { locked: true, value: "done" });
    }
  }
});

test("12 workers with random crashes never overlap, die, or leave a lock behind", async () => {
  const result = await runStress({ implA: IMPL, nA: 12, implB: IMPL, nB: 0, iters: 30, crashEvery: 40 });
  assert.equal(result.violations, 0);
  assert.equal(result.deaths, 0, result.firstError);
  assert.equal(result.busy, 0);
  assert.ok(result.crashed > 0 && result.done > 0, JSON.stringify(result));
  // A crash on the last acquisition leaves a dead owner; one more acquire breaks it, as a later caller would.
  assert.equal(withLockSync(result.file, () => "ok").locked, true);
  assert.deepEqual(readdirSync(result.dir), []);
});

test("callers after a holder releases while its process lingers still acquire", async () => {
  const result = await runStuck(IMPL);
  assert.deepEqual(result.results, ["B true", "C true", "E true"]);
  assert.equal(result.maxHolders, 1);
  assert.deepEqual(result.leftover, []);
});

test("6 old-code and 6 new-code workers on one lock never overlap", async () => {
  const result = await runStress({ implA: OLD_LOCK, nA: 6, implB: IMPL, nB: 6, iters: 30, crashEvery: 0 });
  assert.equal(result.violations, 0);
  assert.equal(result.deaths, 0, result.firstError);
});
