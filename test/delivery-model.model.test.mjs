// Model-based test of the delivery workflow: redelivery, busy waits, acks, TTL and durable restarts, on a fake clock.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock, test, after } from "node:test";
import fc from "fast-check";
import { MAX_ATTEMPTS, nextAction, REDELIVER_MS, TTL_MS } from "../lib/delivery.ts";
import { openDurable } from "../runner/durable.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// DELIVERY_IMPL points the model at another delivery.mjs, e.g. a scratch copy with a planted bug.
const DELIVERY_IMPL = process.env.DELIVERY_IMPL ? path.resolve(process.env.DELIVERY_IMPL) : fileURLToPath(new URL("../runner/delivery.mjs", import.meta.url));
const { DELIVERY, READY_POLL_MS, deliveryWorkflow } = await import(pathToFileURL(DELIVERY_IMPL).href);

const T0 = Date.UTC(2026, 10, 25);
const SESSION = { id: "opencode#abc", harness: "opencode", sessionId: "ses_1", online: true, peer: "opencode", session: "abc" };
const SCFG = { project: "demo", peer: "opencode", session: "abc" };
const MAX_MESSAGES = 2;
const ADVANCES = [1000, READY_POLL_MS, 60_000, REDELIVER_MS, 2 * 3_600_000, TTL_MS + 1000];
const GRACE_MS = REDELIVER_MS + READY_POLL_MS;
const NUM_RUNS = Number(process.env.FC_RUNS ?? 200);
const SEED = process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

/** Abstract state: the target's ready and busy flags, and per message its state, ack, and terminal push count. */
function initialModel() {
  return { target: { ready: true, busy: false }, messages: [] };
}

/** Real side: the durable log, the fake target and ack set, and every push the workflow made. */
function openReal(dir) {
  return { dir, file: path.join(dir, "runner.db"), durable: null, target: { ready: true, busy: false, cutNext: false }, acked: new Map(), pushes: [], seq: 0 };
}

const flushed = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Runs the fake clock forward in READY_POLL_MS steps, letting the workflows run between steps. */
async function advance(ms) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(READY_POLL_MS, left);
    mock.timers.tick(step);
    left -= step;
    await flushed();
  }
}

// The deps the workflow runs on: the target is the fake in r.target; pushes and acks are recorded in r.
function depsOf(r) {
  return {
    now: () => Date.now(),
    scfgOf: () => SCFG,
    sessionOf: () => SESSION,
    ready: async () => r.target.ready,
    busy: async () => r.target.busy,
    reserve: async (scfg, ids) => ({ owned: ids, busy: false }),
    release: async () => {},
    markDelivered: async () => {},
    snapshot: async () => null,
    push: async (session, { text, ids }) => {
      const attempt = Number(/attempt (\d+)$/.exec(text)[1]);
      r.pushes.push({ msg: ids[0], attempt, at: Date.now(), busy: r.target.busy, seq: (r.seq += 1) });
      if (r.target.cutNext) {
        r.target.cutNext = false;
        r.target.ready = false;
        return { status: "cut" };
      }
      return { status: "delivered" };
    },
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked: async (project, address, message) => r.acked.has(message.id),
    textFor: (scfg, message, attempt) => `${message.id} attempt ${attempt}`,
  };
}

async function openRunner(r) {
  r.durable = openDurable(r.file, { now: () => Date.now() });
  r.durable.register(DELIVERY, deliveryWorkflow(depsOf(r)));
}

const workflowId = (id) => `${DELIVERY}:${SESSION.id}:${id}`;

/** Checks the invariants the model and the real log must share after every command. */
async function checkInvariants(m, r) {
  await flushed();
  const now = Date.now();
  for (const msg of m.messages) {
    const rows = r.pushes.filter((p) => p.msg === msg.id);
    if (msg.ackSeq !== null) assert.ok(rows.every((p) => p.seq < msg.ackSeq), `push after ack on ${msg.id}`);
    assert.ok(rows.every((p) => p.at < msg.createdAt + TTL_MS), `push after TTL on ${msg.id}`);
    assert.ok(rows.every((p) => p.attempt === 1 || !p.busy), `push while busy on ${msg.id}`);
    assert.ok(rows.length <= MAX_ATTEMPTS, `${rows.length} pushes on ${msg.id}, limit ${MAX_ATTEMPTS}`);
    msg.pushed = rows.length > 0;
    // Every push must be one the shared policy allows at its time: TTL, redelivery gap, answer, attempt cap, busy.
    for (const [i, p] of rows.entries()) {
      // The runner's dueAt is its wake: on this clock, the previous push plus REDELIVER_MS, as the durable sleep began at that push.
      const dueAt = i === 0 ? null : rows[i - 1].at + REDELIVER_MS;
      const acked = msg.ackSeq !== null && msg.ackSeq < p.seq;
      const action = nextAction({ firstAt: msg.createdAt, pushes: p.attempt - 1, dueAt }, p.at, { acked, busy: p.busy, ready: true });
      assert.equal(action, "push", `policy forbids attempt ${p.attempt} on ${msg.id}: ${action}`);
    }
    const attempts = rows.map((p) => p.attempt);
    assert.equal(new Set(attempts).size, attempts.length, `an attempt was pushed twice on ${msg.id}`);
    const status = r.durable.status(workflowId(msg.id));
    assert.ok(status, `no workflow for ${msg.id}`);
    assert.notEqual(status.status, "ERROR", `workflow for ${msg.id} errored: ${status.error}`);
    if (status.status === "SUCCESS") {
      msg.state ??= status.output.status;
      assert.equal(status.output.status, msg.state, `terminal state of ${msg.id} changed`);
      msg.pushesAtEnd ??= rows.length;
      assert.equal(rows.length, msg.pushesAtEnd, `${msg.id} pushed after its terminal state`);
    } else {
      assert.ok(now - msg.createdAt <= TTL_MS + GRACE_MS, `${msg.id} pending ${now - msg.createdAt} ms after creation`);
    }
  }
}

class NewMessage {
  check(m) {
    return m.messages.length < MAX_MESSAGES;
  }

  async run(m, r) {
    const id = `m${m.messages.length + 1}`;
    const message = { id, from: "claude#def", body: "hi", expectReply: true };
    m.messages.push({ id, createdAt: Date.now(), state: null, ackSeq: null, pushesAtEnd: null });
    r.durable.startWorkflowOnce(DELIVERY, workflowId(id), { project: "demo", address: SESSION.id, message })?.catch(() => {});
    await checkInvariants(m, r);
  }

  toString() {
    return "NewMessage";
  }
}

class Tick {
  constructor(ms) {
    this.ms = ms;
  }

  check() {
    return true;
  }

  async run(m, r) {
    await advance(this.ms);
    await checkInvariants(m, r);
  }

  toString() {
    return `Tick(${this.ms / 1000}s)`;
  }
}

class SetBusy {
  constructor(busy) {
    this.busy = busy;
  }

  check() {
    return true;
  }

  async run(m, r) {
    r.target.busy = this.busy;
    m.target.busy = this.busy;
    await checkInvariants(m, r);
  }

  toString() {
    return `SetBusy(${this.busy})`;
  }
}

class SetReady {
  constructor(ready) {
    this.ready = ready;
  }

  check() {
    return true;
  }

  async run(m, r) {
    r.target.ready = this.ready;
    m.target.ready = this.ready;
    await checkInvariants(m, r);
  }

  toString() {
    return `SetReady(${this.ready})`;
  }
}

// Answer (reply or done) and Read (receipt) both put an ack on the message; each needs a push first.
class Ack {
  constructor(i, kind) {
    this.i = i;
    this.kind = kind;
  }

  check(m) {
    const msg = m.messages[this.i];
    return Boolean(msg) && msg.state === null && msg.ackSeq === null && msg.pushed === true;
  }

  async run(m, r) {
    const msg = m.messages[this.i];
    r.acked.set(msg.id, this.kind);
    msg.ackSeq = (r.seq += 1);
    await checkInvariants(m, r);
  }

  toString() {
    return `${this.kind === "reply" ? "Answer" : "Read"}(${this.i})`;
  }
}

class Cut {
  check() {
    return true;
  }

  async run(m, r) {
    r.target.cutNext = true;
    await checkInvariants(m, r);
  }

  toString() {
    return "Cut";
  }
}

class RestartRunner {
  check() {
    return true;
  }

  async run(m, r) {
    await r.durable.close();
    await openRunner(r);
    r.durable.recover();
    await checkInvariants(m, r);
  }

  toString() {
    return "RestartRunner";
  }
}

const commandArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(new NewMessage()) },
  { weight: 5, arbitrary: fc.constantFrom(...ADVANCES).map((ms) => new Tick(ms)) },
  { weight: 3, arbitrary: fc.boolean().map((b) => new SetBusy(b)) },
  { weight: 3, arbitrary: fc.boolean().map((b) => new SetReady(b)) },
  { weight: 3, arbitrary: fc.constantFrom(0, 1).map((i) => new Ack(i, "reply")) },
  { weight: 2, arbitrary: fc.constantFrom(0, 1).map((i) => new Ack(i, "read")) },
  { weight: 1, arbitrary: fc.constant(new Cut()) },
  { weight: 1, arbitrary: fc.constant(new RestartRunner()) },
);

// Runs one command sequence from a fresh log on the fake clock; the model and invariants check every step.
async function runSequence(cmds) {
  const dir = tempDir({ after }, "delivery-model-");
  const r = openReal(dir);
  await openRunner(r);
  try {
    await fc.asyncModelRun(() => ({ model: initialModel(), real: r }), cmds);
  } finally {
    await r.durable.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The fake clock runs for the whole body of fn, so every test starts at T0 with no timers left over.
async function onFakeClock(fn) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
}

test("delivery workflow matches the model under random commands on a fake clock", async () => {
  await onFakeClock(() => fc.assert(fc.asyncProperty(fc.commands([commandArb], { maxCommands: 12 }), runSequence), { numRuns: NUM_RUNS, ...SEED }));
});

// Interleavings that random generation rarely reaches: an ack while the target waits, then the target frees up.
// A and B are known bugs in the current delivery.mjs: a push after an answer observed while busy or not ready.
// The fix waits for operator approval, so they stay todo; C runs and guards the busy-wait ack check.
const KNOWN_BUG = "push after an answer observed while busy or not ready; fix pending operator approval";
const SCENARIOS = [
  { name: "ack during a busy wait, busy cleared before the next poll", commands: () => [new NewMessage(), new Tick(1000), new SetBusy(true), new Tick(REDELIVER_MS), new Ack(0, "reply"), new SetBusy(false), new Tick(60_000)] },
  { name: "ack while not ready, ready before the next poll", commands: () => [new NewMessage(), new Tick(1000), new SetReady(false), new Tick(REDELIVER_MS), new Ack(0, "reply"), new SetReady(true), new Tick(60_000)] },
  { name: "ack during a busy wait, still busy at the next poll", commands: () => [new NewMessage(), new Tick(1000), new SetBusy(true), new Tick(REDELIVER_MS), new Ack(0, "reply"), new Tick(READY_POLL_MS), new SetBusy(false), new Tick(60_000)] },
];

for (const { name, todo, commands } of SCENARIOS) {
  test(`scenario: ${name}`, { todo }, () => onFakeClock(() => runSequence(commands())));
}
