// Model-based test of the store lock: random command sequences run against lib/store.ts with real holder processes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, after } from "node:test";
import fc from "fast-check";
import { tempDir } from "./helpers/tmp.mjs";

// STORE_IMPL points the model at another store.ts, e.g. a scratch copy of an older commit.
const IMPL = process.env.STORE_IMPL ? path.resolve(process.env.STORE_IMPL) : fileURLToPath(new URL("../lib/store.ts", import.meta.url));
const HOLDER = fileURLToPath(new URL("./helpers/lock-holder.mjs", import.meta.url));
const PROCS = [0, 1];
const ADVANCES = [5000, 25000];
const STALE_MS = 2000;
const CEILING_MS = 10 * STALE_MS;
const WAIT_MS = 30;
const NUM_RUNS = Number(process.env.FC_RUNS ?? 200);
const LINE_TIMEOUT_MS = 10000;
const SEED = process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

/** Abstract state: virtual clock, the lock (owner, kind, since), which processes hold, and overlaps the store may allow. */
function initialModel() {
  return { now: 0, lock: null, holding: PROCS.map(() => false), overlaps: 0 };
}

/** Real side: a temp dir, the lock file, live holder children keyed by process, and observed overlaps. */
function makeReal(dir) {
  return { dir, file: path.join(dir, "state.json"), children: new Map(), pids: new Map(), spawned: 0, violations: 0 };
}

function lockDir(r) {
  return `${r.file}.lock`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function alive(r, p) {
  const entry = r.children.get(p);
  return Boolean(entry && isAlive(entry.child));
}

/** Sets the lock dir mtime so its age equals the model's virtual age. */
function syncClock(r, m) {
  if (!m.lock || !fs.existsSync(lockDir(r))) return;
  const at = (Date.now() - (m.now - m.lock.since)) / 1000;
  fs.utimesSync(lockDir(r), at, at);
}

function spawnHolder(r, p) {
  r.spawned += 1;
  const release = path.join(r.dir, `release.${p}.${r.spawned}`);
  const args = [HOLDER, pathToFileURL(IMPL).href, r.file, String(WAIT_MS), String(STALE_MS), String(p), release];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  r.children.set(p, { child, release });
  r.pids.set(p, child.pid);
  return child;
}

/** The holder's first stdout line: "IN <violation>", "BUSY", or "CLOSED" if it exits first. */
function firstLine(child) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error(`holder ${child.pid} printed nothing`)), LINE_TIMEOUT_MS);
    rl.once("line", (line) => {
      clearTimeout(timer);
      rl.close();
      resolve(line);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve("CLOSED");
    });
  });
}

function waitClose(child) {
  if (!isAlive(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

function removeMarkerOf(r, p) {
  const marker = `${r.file}.inside`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === String(p)) fs.rmSync(marker, { force: true });
}

async function killAll(r) {
  for (const { child } of r.children.values()) {
    if (isAlive(child)) child.kill("SIGKILL");
    await waitClose(child);
  }
}

/** Checks model against real after every command: lock presence, owner, holders, overlaps, leftovers. */
function checkInvariants(m, r) {
  assert.equal(fs.existsSync(lockDir(r)), m.lock !== null, "lock presence differs from model");
  if (m.lock) {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir(r), "owner.json"), "utf8"));
    const expectPid = m.lock.kind === "reused" ? process.pid : r.pids.get(m.lock.owner);
    assert.equal(owner.pid, expectPid, `owner pid differs from model owner ${m.lock.owner} (${m.lock.kind})`);
    if (m.lock.kind === "live") assert.equal(alive(r, m.lock.owner), true, "live owner is not running");
    if (m.lock.kind === "dead") assert.equal(pidAlive(owner.pid), false, "dead owner pid is alive");
  }
  PROCS.forEach((p) => assert.equal(alive(r, p), m.holding[p], `holder ${p} alive differs from model`));
  assert.ok(r.violations <= m.overlaps, `${r.violations} overlapping entries, model allows ${m.overlaps}`);
  if (!m.holding.some(Boolean)) {
    const base = path.basename(lockDir(r));
    const stray = fs.readdirSync(r.dir).filter((n) => n.startsWith(`${base}.break`) || n.startsWith(`${base}.rel.`) || n === `${path.basename(r.file)}.inside`);
    assert.deepEqual(stray, [], "stray entries after a quiescent point");
  }
}

class Acquire {
  constructor(p) {
    this.p = p;
  }

  check(m) {
    return !m.holding[this.p];
  }

  async run(m, r) {
    const { p } = this;
    syncClock(r, m);
    const lock = m.lock;
    const mustLock = lock === null || lock.kind !== "live";
    const mustBusy = lock !== null && lock.kind === "live" && m.now - lock.since < CEILING_MS;
    // Over the ceiling the store may break a live owner; the model then follows the real outcome.
    const child = spawnHolder(r, p);
    const line = await firstLine(child);
    assert.notEqual(line, "CLOSED", `holder ${p} exited without a result`);
    const got = line.startsWith("IN") ? "IN" : line;
    if (mustLock) assert.equal(got, "IN", `Acquire(${p}) on a ${lock ? lock.kind : "free"} lock must succeed`);
    if (mustBusy) assert.equal(got, "BUSY", `Acquire(${p}) on a healthy lock younger than the ceiling must fail`);
    if (got === "IN") {
      if (m.holding.some((held, x) => held && x !== p)) m.overlaps += 1;
      if (line === "IN 1") r.violations += 1;
      m.lock = { owner: p, kind: "live", since: m.now };
      m.holding[p] = true;
    } else {
      await waitClose(child);
    }
    checkInvariants(m, r);
  }

  toString() {
    return `Acquire(${this.p})`;
  }
}

class Release {
  constructor(p) {
    this.p = p;
  }

  check() {
    return true;
  }

  async run(m, r) {
    const { p } = this;
    const entry = r.children.get(p);
    if (entry && isAlive(entry.child)) {
      fs.writeFileSync(entry.release, "");
      await waitClose(entry.child);
      m.holding[p] = false;
      if (m.lock && m.lock.owner === p) m.lock = null;
    }
    checkInvariants(m, r);
  }

  toString() {
    return `Release(${this.p})`;
  }
}

class Crash {
  constructor(p) {
    this.p = p;
  }

  check() {
    return true;
  }

  async run(m, r) {
    const { p } = this;
    const entry = r.children.get(p);
    if (entry && isAlive(entry.child)) {
      entry.child.kill("SIGKILL");
      await waitClose(entry.child);
      m.holding[p] = false;
      removeMarkerOf(r, p);
    }
    if (m.lock && m.lock.owner === p && m.lock.kind === "live") m.lock.kind = "dead";
    checkInvariants(m, r);
  }

  toString() {
    return `Crash(${this.p})`;
  }
}

class ReusePid {
  constructor(p) {
    this.p = p;
  }

  check(m) {
    return m.lock !== null && m.lock.kind === "dead" && m.lock.owner === this.p;
  }

  async run(m, r) {
    const file = path.join(lockDir(r), "owner.json");
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...owner, pid: process.pid, start: -1 }));
    m.lock.kind = "reused";
    checkInvariants(m, r);
  }

  toString() {
    return `ReusePid(${this.p})`;
  }
}

class Advance {
  constructor(ms) {
    this.ms = ms;
  }

  check() {
    return true;
  }

  async run(m, r) {
    m.now += this.ms;
    checkInvariants(m, r);
  }

  toString() {
    return `Advance(${this.ms})`;
  }
}

const procArb = fc.constantFrom(...PROCS);
const commandArb = fc.oneof(
  { weight: 3, arbitrary: procArb.map((p) => new Acquire(p)) },
  { weight: 2, arbitrary: procArb.map((p) => new Release(p)) },
  { weight: 2, arbitrary: procArb.map((p) => new Crash(p)) },
  { weight: 2, arbitrary: procArb.map((p) => new ReusePid(p)) },
  { weight: 2, arbitrary: fc.constantFrom(...ADVANCES).map((ms) => new Advance(ms)) },
);

test("store lock matches the model under random command sequences", async () => {
  await fc.assert(fc.asyncProperty(fc.commands([commandArb], { maxCommands: 12 }), async (cmds) => {
    const dir = tempDir({ after }, "store-lock-model-");
    const real = makeReal(dir);
    try {
      await fc.asyncModelRun(() => ({ model: initialModel(), real }), cmds);
    } finally {
      await killAll(real);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }), { numRuns: NUM_RUNS, ...SEED });
});
