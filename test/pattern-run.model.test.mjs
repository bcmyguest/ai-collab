// Model-based test of pattern-run handoffs: advances, operator overrides, confirmations, member crashes and runner
// restarts at every step boundary, run through lib/pattern-workflow.ts on the durable log against lib/pattern-runs.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import fc from "fast-check";
import { activatePatternTargets, applyPatternAdvance, cutPatternEnter, cutPatternEntry, cutPatternLeave, launchPatternRun, runStatus } from "../lib/pattern-runs.ts";
import { patternWorkflowId, runPatternWorkflow, seedPatternRun } from "../lib/pattern-workflow.ts";
import { openDurable } from "../lib/durable.ts";
import { tempDir } from "./helpers/tmp.mjs";

const DONE = "done";
const RUN_ID = "model01";
const MAX_VISITS = 2;
// lead splits to two workers; workers fan in to review or ask lead for help; review sends changes (cap 1) or approves.
const DEFINITION = {
  name: "model",
  maxVisits: MAX_VISITS,
  roles: [
    { id: "lead", responsibility: "Split the work.", harness: "claude" },
    { id: "worker", responsibility: "Build one part.", harness: "claude", count: 2 },
    { id: "review", responsibility: "Review the parts.", harness: "claude" },
  ],
  handoffs: [
    { from: "lead", to: "worker", on: "split", kind: "broadcast" },
    { from: "lead", to: DONE, on: "skip", required: false },
    { from: "worker", to: "review", on: "built", kind: "fan-in", required: true },
    { from: "worker", to: "lead", on: "help", kind: "broadcast" },
    { from: "review", to: "worker", on: "changes", kind: "broadcast", cap: 1 },
    { from: "review", to: DONE, on: "approve", required: true },
  ],
};
const INSTANCES = DEFINITION.roles.flatMap((role) => Array.from({ length: role.count ?? 1 }, (_, index) => ({ role: role.id, index })));
const EVENTS = [...new Set(DEFINITION.handoffs.map((handoff) => handoff.on))];
const CRASHES = ["none", "beforeLeave", "inLeave", "between", "inEnter"];
const SETTLE_MS = 5000;
const NUM_RUNS = Number(process.env.FC_RUNS ?? 150);
const SEED = process.env.FC_SEED ? { seed: Number(process.env.FC_SEED), path: process.env.FC_PATH } : {};
const DRIVE_STEPS = 40;

const key = (role, index) => `${role}#${index}`;
const countOf = (roleId) => DEFINITION.roles.find((role) => role.id === roleId).count ?? 1;
const sameEdge = (a, b) => a.from === b.from && a.to === b.to && a.on === b.on;

/** Abstract state, the run's variables: status, live tokens, visits, handoff log, fan-in arrivals, sessions, deliveries. */
function initialModel() {
  return {
    status: "running",
    live: [{ role: "lead", index: 0 }],
    visits: { lead: [1] },
    handoffs: [],
    arrivals: {},
    suspension: null,
    sessions: { [key("lead", 0)]: true },
    launches: { [key("lead", 0)]: 1 },
    deliveries: {},
    ended: new Set(),
    failLaunch: false,
  };
}

/** Action Decide: who holds the step and what the event does. Returns { error } or a plan. */
function modelDecide(m, on, who) {
  if (m.live.length === 0) return { error: "no live role" };
  let tokens;
  if (who.kind === "operator") tokens = m.live.filter((token) => token.role === m.live[0].role);
  else tokens = m.live.filter((token) => key(token.role, token.index) === key(who.role, who.index) && m.sessions[key(who.role, who.index)]).slice(0, 1);
  if (tokens.length === 0) return { error: "not a live holder" };
  const role = tokens[0].role;
  const indexes = tokens.map((token) => token.index);
  const handoff = DEFINITION.handoffs.find((item) => item.from === role && item.on === on);
  if (!handoff) return { error: "no such handoff" };
  if (handoff.to === DONE) {
    const missing = DEFINITION.handoffs.filter((req) => req.required && !sameEdge(req, handoff) && !m.handoffs.some((item) => sameEdge(item, req)));
    if (missing.length) return { error: "required handoff missing" };
    return { kind: "done", handoff, role, indexes };
  }
  let fires = indexes;
  if (handoff.kind === "fan-in") {
    const arrived = [...new Set([...(m.arrivals[handoff.to] ?? []).filter((a) => a.from === role && a.on === on).map((a) => a.index), ...indexes])].sort((a, b) => a - b);
    if (arrived.length < countOf(role)) return { kind: "wait", handoff, role, indexes: arrived };
    fires = arrived;
  }
  const plan = { kind: "move", handoff, role, indexes: fires };
  const instance = fires.join(",");
  const capped = handoff.cap !== undefined && m.handoffs.filter((item) => sameEdge(item, handoff) && item.instance === instance).length >= handoff.cap;
  const over = modelTargets(plan).some((t) => (m.visits[t.role]?.[t.index] ?? 0) >= MAX_VISITS);
  if (capped || over) plan.limit = true;
  return plan;
}

function modelTargets(plan) {
  const indexes = (plan.handoff.kind ?? "pair") === "pair" ? plan.indexes : [...Array(countOf(plan.handoff.to)).keys()];
  return indexes.map((index) => ({ role: plan.handoff.to, index }));
}

/** Action Commit (the leave step): records the handoff and moves the tokens; at most one token per instance. */
function modelCommit(m, plan, confirmed) {
  if (plan.limit && !confirmed) {
    m.status = "suspended";
    return { kind: "suspended" };
  }
  m.status = "running";
  m.suspension = null;
  m.live = m.live.filter((token) => !(token.role === plan.role && plan.indexes.includes(token.index)));
  if (plan.kind === "wait") {
    const kept = (m.arrivals[plan.handoff.to] ?? []).filter((a) => !(a.from === plan.role && a.on === plan.handoff.on));
    m.arrivals[plan.handoff.to] = [...kept, ...plan.indexes.map((index) => ({ from: plan.role, on: plan.handoff.on, index }))];
    return { kind: "wait" };
  }
  if (plan.handoff.kind === "fan-in") m.arrivals[plan.handoff.to] = (m.arrivals[plan.handoff.to] ?? []).filter((a) => !(a.from === plan.role && a.on === plan.handoff.on));
  m.handoffs.push({ from: plan.handoff.from, to: plan.handoff.to, on: plan.handoff.on, instance: plan.indexes.join(",") });
  if (plan.kind === "done") {
    if (m.live.length === 0) m.status = "done";
    return { kind: "done" };
  }
  const targets = modelTargets(plan);
  for (const t of targets) {
    if (!m.live.some((token) => token.role === t.role && token.index === t.index)) m.live.push(t);
    const list = m.visits[t.role] ?? [];
    list[t.index] = (list[t.index] ?? 0) + 1;
    m.visits[t.role] = list;
  }
  return { kind: "move", targets };
}

/** Action Enter: each target gets the brief once, by message to its session or by one launch; a failed launch fails the run. */
function modelEnter(m, targets) {
  const undelivered = [];
  for (const t of targets) {
    const k = key(t.role, t.index);
    if (m.sessions[k]) {
      if (m.ended.has(k)) undelivered.push(k);
      else m.deliveries[k] = (m.deliveries[k] ?? 0) + 1;
      continue;
    }
    if (m.failLaunch) {
      m.failLaunch = false;
      m.status = "failed";
      return { failed: true, undelivered };
    }
    m.sessions[k] = true;
    m.launches[k] = (m.launches[k] ?? 0) + 1;
  }
  return { failed: false, undelivered };
}

/** Action Cut: a restart with a step left started fails a running run (it cannot tell whether the effect happened). */
function modelCut(m) {
  if (m.status === "running") m.status = "failed";
}

/** Real side: a durable log, the run file, a fake harness start, and delivery ledgers keyed by instance. */
function makeReal(dir) {
  const cfg = { project: "demo", peer: "operator", session: "", stateDir: path.join(dir, "state"), peers: [] };
  return {
    dir, cfg, db: path.join(dir, "runner.db"), durable: null, n: 0,
    launches: {}, deliveries: {}, addressKey: new Map(), ended: new Set(), failLaunch: false,
    crash: null, parked: null, replies: new Map(), requests: 0, handling: "",
  };
}

function instanceOfPrompt(prompt) {
  const role = prompt.match(/role "([^"]+)"/)[1];
  const nth = prompt.match(/Instance (\d+) of/);
  return { role, index: nth ? Number(nth[1]) - 1 : 0 };
}

function waitForAbort(wf) {
  return new Promise((_, reject) => {
    if (wf.signal.aborted) reject(new Error("closed"));
    wf.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
  });
}

/** Parks the workflow at a crash point of the armed request until the engine closes under it; replayed steps never park. */
async function crashPoint(r, wf, point) {
  if (r.crash?.point !== point || r.crash.request !== r.handling) return;
  r.crash = null;
  r.parked?.();
  await waitForAbort(wf);
}

/** The deps runner/runner.ts passes to runPatternWorkflow, with a fake start and notify and crash points. */
function deps(r) {
  const { cfg } = r;
  const env = {};
  const start = async (_cfg, options) => {
    const { role, index } = instanceOfPrompt(options.prompt);
    if (r.failLaunch) {
      r.failLaunch = false;
      throw new Error("harness refused");
    }
    r.n += 1;
    const address = `claude#${r.n.toString(16).padStart(16, "0")}`;
    r.addressKey.set(address, key(role, index));
    r.launches[key(role, index)] = (r.launches[key(role, index)] ?? 0) + 1;
    return { status: "started", session: address, detail: "ok" };
  };
  const notify = async (address) => {
    const k = r.addressKey.get(address);
    if (r.ended.has(k)) throw new Error("The owned session has ended");
    r.deliveries[k] = (r.deliveries[k] ?? 0) + 1;
  };
  const visible = (advanced) => {
    const reply = { ...advanced };
    delete reply.targets;
    delete reply.arrival;
    return reply;
  };
  let wfRef = null;
  return {
    enterEntry: (input, runId) => launchPatternRun(cfg, seedPatternRun(input, runId, () => 1_000_000), env, start),
    leave: async (runId, message) => {
      r.handling = message.request;
      await crashPoint(r, wfRef, "beforeLeave");
      let outcome;
      try {
        const advanced = await applyPatternAdvance(cfg, runId, message.event, { ...message.options, env, now: () => 2_000_000, start, notify, launchNext: false });
        const targets = advanced.targets ?? [];
        outcome = { reply: visible(advanced), launch: advanced.status === "running" && targets.length > 0, targets, arrival: advanced.arrival };
      } catch (error) {
        if (wfRef.signal.aborted) throw error;
        outcome = { error: error.message, launch: false };
      }
      await crashPoint(r, wfRef, "inLeave");
      return outcome;
    },
    enterNext: async (runId, left) => {
      const activated = await activatePatternTargets(cfg, runId, left.targets, left.arrival, { env, start, notify });
      return { reply: { ...left.reply, ...activated, handoff: left.reply?.handoff } };
    },
    cutEntry: (_input, runId) => cutPatternEntry(cfg, runId),
    cutLeave: (runId) => cutPatternLeave(cfg, runId),
    cutEnter: (runId, left) => cutPatternEnter(cfg, runId, left.targets),
    between: (wf) => crashPoint(r, wf, "between"),
    afterEnter: (wf) => crashPoint(r, wf, "inEnter"),
    reply: (request, outcome) => r.replies.get(request)?.(outcome),
    bind: (wf) => { wfRef = wf; },
  };
}

function openEngine(r) {
  r.durable = openDurable(r.db);
  r.durable.register("pattern", (wf, input) => {
    const d = deps(r);
    d.bind(wf);
    return runPatternWorkflow(wf, input, d);
  });
}

const workflowId = patternWorkflowId(RUN_ID);
const input = { name: DEFINITION.name, task: "Ship the model", definition: DEFINITION, project: "demo" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Idle: the workflow ended, or the run is live, every sent advance was taken, and the last step is a finished enter or a leave that launches nothing. */
async function settle(r) {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const status = r.durable.status(workflowId)?.status;
    const steps = r.durable.steps(workflowId);
    const last = steps.at(-1);
    const taken = steps.filter((step) => step.name === "event").length === r.requests;
    // A run that reached a terminal state is idle only once its workflow has ended too.
    const ending = ["done", "failed"].includes(runStatus(r.cfg, RUN_ID).status);
    const idle = status !== "PENDING" || (taken && !ending && last && !steps.some((step) => step.status === "started")
      && ((last.name === "enter" && last.status === "done") || (last.name === "leave" && last.status === "done" && !JSON.parse(last.output).launch)));
    if (idle) return;
    assert.ok(Date.now() < until, `workflow did not settle: ${JSON.stringify(steps.map((s) => [s.name, s.status]))}`);
    await sleep(5);
  }
}

async function startReal(r) {
  openEngine(r);
  const request = "entry";
  const replied = new Promise((resolve) => r.replies.set(request, resolve));
  r.durable.startWorkflow("pattern", workflowId, { ...input, request }).catch(() => {});
  await replied;
  await settle(r);
}

/** Sends one advance; resolves with the reply, or { crashed: true } when the armed crash point parks the workflow. */
async function sendAdvance(r, event, options) {
  if (r.durable.status(workflowId).status !== "PENDING") return { closed: true };
  r.requests += 1;
  const request = `req${r.requests}`;
  if (r.crash) r.crash = { point: r.crash, request };
  const replied = new Promise((resolve) => r.replies.set(request, resolve));
  const parked = new Promise((resolve) => { r.parked = () => resolve({ crashed: true }); });
  r.durable.send(workflowId, "advance", { request, event, options });
  const outcome = await Promise.race([replied, parked]);
  r.replies.delete(request);
  r.parked = null;
  if (!outcome.crashed) await settle(r);
  return outcome;
}

/** Action Restart: the engine stops mid-step and a new one recovers the log. */
async function restart(r) {
  r.crash = null;
  await r.durable.close();
  openEngine(r);
  r.durable.recover();
  await settle(r);
}

/** Checks the real run against the model after every command. */
function checkInvariants(m, r) {
  const run = runStatus(r.cfg, RUN_ID);
  assert.equal(run.status, m.status, "run status differs from the model");
  // At most one holder per step: no instance holds two live tokens.
  const liveKeys = (run.live ?? []).map((token) => key(token.role, token.index));
  assert.equal(new Set(liveKeys).size, liveKeys.length, `an instance holds two live tokens: ${liveKeys.join(" ")}`);
  assert.deepEqual(liveKeys, m.live.map((token) => key(token.role, token.index)), "live tokens differ from the model");
  // No handoff lost or applied twice: the log equals the model's, in order, numbered 1..n.
  assert.deepEqual(run.handoffs.map(({ from, to, on, instance }) => ({ from, to, on, instance })), m.handoffs, "handoff log differs from the model");
  run.handoffs.forEach((handoff, i) => assert.equal(handoff.seq, i + 1, "handoff seq is not 1..n"));
  assert.deepEqual(run.visits, m.visits, "visits differ from the model");
  const arrivals = Object.fromEntries(Object.entries(run.arrivals ?? {}).filter(([, list]) => list.length));
  const expectArrivals = Object.fromEntries(Object.entries(m.arrivals).filter(([, list]) => list.length));
  assert.deepEqual(arrivals, expectArrivals, "fan-in arrivals differ from the model");
  assert.equal(Boolean(run.suspension), m.status === "suspended", "suspension record differs from status");
  // A restart resumes, never forks: each instance launched at most once, and exactly as often as the model says.
  for (const { role, index } of INSTANCES) {
    const k = key(role, index);
    assert.equal(r.launches[k] ?? 0, m.launches[k] ?? 0, `launches of ${k} differ from the model`);
    assert.ok((r.launches[k] ?? 0) <= 1, `${k} launched twice`);
    assert.equal(r.deliveries[k] ?? 0, m.deliveries[k] ?? 0, `briefs delivered to ${k} differ from the model`);
  }
  // A terminal run ends its workflow.
  const wf = r.durable.status(workflowId);
  if (m.status === "done" || m.status === "failed") assert.equal(wf.status, "SUCCESS", "a terminal run left its workflow open");
  else assert.equal(wf.status, "PENDING", "a live run's workflow ended");
}

function callerOf(r, who) {
  if (who.kind === "operator") return { override: true, by: "operator" };
  const run = runStatus(r.cfg, RUN_ID);
  const address = run.instances?.[who.role]?.[who.index] ?? (who.index === 0 ? run.sessions?.[who.role] : "") ?? "";
  return { caller: address || "", override: false };
}

/** Action Advance (+ Crash at a step boundary, then Restart). */
class Advance {
  constructor(who, event, crash) {
    this.who = who;
    this.event = event;
    this.crash = crash;
  }

  check() {
    return true;
  }

  /** A holder pick and an own-event index resolve against the model, so most advances are ones a live role would send. */
  resolve(m) {
    const who = this.who.kind !== "holder" ? this.who
      : m.live.length ? { kind: "session", ...m.live[this.who.pick % m.live.length] } : { kind: "operator" };
    const role = who.kind === "operator" ? m.live[0]?.role : who.role;
    const own = DEFINITION.handoffs.filter((handoff) => handoff.from === role);
    const event = typeof this.event === "string" ? this.event : own.length ? own[this.event.own % own.length].on : EVENTS[0];
    this.resolved = { who, event };
    return this.resolved;
  }

  async run(m, r) {
    const { who, event } = this.resolve(m);
    const closed = m.status === "done" || m.status === "failed";
    const plan = closed || m.status === "suspended" ? { error: `run is ${m.status}` } : modelDecide(m, event, who);
    r.crash = this.crash === "none" ? null : this.crash;
    const got = await sendAdvance(r, event, { note: "", ...callerOf(r, who) });
    if (closed) {
      assert.ok(got.closed, "an ended run's workflow took an advance");
      r.crash = null;
      checkInvariants(m, r);
      return;
    }
    // The model's expected effect, by where the crash cut the step.
    if (this.crash === "beforeLeave") {
      assert.ok(got.crashed, "beforeLeave did not park");
      await restart(r);
      modelCut(m);
      checkInvariants(m, r);
      return;
    }
    const committed = plan.error ? { kind: "error" } : modelCommit(m, plan, false);
    if (this.crash === "inLeave") {
      assert.ok(got.crashed, "inLeave did not park");
      await restart(r);
      modelCut(m);
      checkInvariants(m, r);
      return;
    }
    const launches = committed.kind === "move" && m.status === "running";
    if (this.crash === "between") {
      assert.ok(got.crashed, "between did not park");
      await restart(r);
      if (launches) modelEnter(m, committed.targets);
      checkInvariants(m, r);
      return;
    }
    if (this.crash === "inEnter" && launches) {
      assert.ok(got.crashed, "inEnter did not park");
      const entered = modelEnter(m, committed.targets);
      await restart(r);
      // The cut enter resumes only when every target is on its first visit with a recorded session.
      const resumable = !entered.failed && committed.targets.every((t) => m.visits[t.role][t.index] === 1);
      if (!resumable) modelCut(m);
      checkInvariants(m, r);
      return;
    }
    r.crash = null;
    assert.ok(!got.crashed, "no crash point was armed");
    if (plan.error) {
      assert.ok(got.error, `expected a refusal (${plan.error}), got ${JSON.stringify(got.reply)}`);
    } else {
      assert.ok(got.reply, `expected a reply, got error ${got.error}`);
      if (launches) {
        const entered = modelEnter(m, committed.targets);
        // A brief the target's session cannot take is reported, not dropped silently.
        for (const k of entered.undelivered) assert.match(got.reply.detail, /message to .* failed/, `undelivered brief to ${k} is not reported`);
      }
      assert.equal(got.reply.status, m.status, "reply status differs from the model");
    }
    checkInvariants(m, r);
  }

  toString() {
    const { who, event } = this.resolved ?? { who: this.who, event: this.event };
    const name = who.kind === "operator" ? "operator" : who.kind === "holder" ? `holder${who.pick}` : key(who.role, who.index);
    return `Advance(${name}, ${typeof event === "string" ? event : `own${event.own}`}${this.crash === "none" ? "" : `, crash=${this.crash}`})`;
  }
}

/** Action Confirm: the operator confirms a suspended handoff. */
class Confirm {
  check(m) {
    return m.status === "suspended";
  }

  async run(m, r) {
    const run = runStatus(r.cfg, RUN_ID);
    const pending = run.suspension;
    const who = pending.override ? { kind: "operator" } : { kind: "session", ...instanceOfAddress(r, pending.caller) };
    const plan = modelDecide(m, pending.on, who);
    assert.ok(!plan.error && plan.limit, "the suspended handoff is no longer pending in the model");
    const got = await sendAdvance(r, "", { override: true, by: "operator", confirmation: pending.id });
    assert.ok(got.reply, `confirm failed: ${got.error}`);
    const committed = modelCommit(m, plan, true);
    if (committed.kind === "move") modelEnter(m, committed.targets);
    assert.equal(got.reply.status, m.status, "confirm reply status differs from the model");
    checkInvariants(m, r);
  }

  toString() {
    return "Confirm";
  }
}

function instanceOfAddress(r, address) {
  const [role, index] = r.addressKey.get(address).split("#");
  return { role, index: Number(index) };
}

/** Action MemberCrash / MemberRestart: a member's session ends or comes back; the run does not notice. */
class Member {
  constructor(role, index, up) {
    this.role = role;
    this.index = index;
    this.up = up;
  }

  check() {
    return true;
  }

  async run(m, r) {
    const k = key(this.role, this.index);
    if (this.up) {
      m.ended.delete(k);
      r.ended.delete(k);
    } else {
      m.ended.add(k);
      r.ended.add(k);
    }
    checkInvariants(m, r);
  }

  toString() {
    return `${this.up ? "MemberRestart" : "MemberCrash"}(${key(this.role, this.index)})`;
  }
}

/** Action LaunchFails: the next harness start fails. */
class LaunchFails {
  check(m) {
    return !m.failLaunch;
  }

  async run(m, r) {
    m.failLaunch = true;
    r.failLaunch = true;
    checkInvariants(m, r);
  }

  toString() {
    return "LaunchFails";
  }
}

/** Action Restart at rest: the engine stops while the workflow waits for an event. */
class RestartIdle {
  check() {
    return true;
  }

  async run(m, r) {
    await restart(r);
    checkInvariants(m, r);
  }

  toString() {
    return "RestartIdle";
  }
}

/** Liveness: the operator drives the run to a terminal state within DRIVE_STEPS overrides and confirmations. */
async function driveToEnd(m, r) {
  m.failLaunch = false;
  r.failLaunch = false;
  for (let i = 0; i < DRIVE_STEPS && (m.status === "running" || m.status === "suspended"); i += 1) {
    if (m.status === "suspended") {
      await new Confirm().run(m, r);
      continue;
    }
    const role = m.live[0].role;
    const approved = m.handoffs.some((item) => item.on === "approve");
    const event = { lead: approved ? "skip" : "split", worker: "built", review: "approve" }[role];
    await new Advance({ kind: "operator" }, event, "none").run(m, r);
  }
  assert.ok(m.status === "done" || m.status === "failed", `run did not end within ${DRIVE_STEPS} operator steps: ${m.status}`);
  checkInvariants(m, r);
}

const whoArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ kind: "operator" }) },
  { weight: 4, arbitrary: fc.nat(3).map((pick) => ({ kind: "holder", pick })) },
  { weight: 1, arbitrary: fc.constantFrom(...INSTANCES).map((inst) => ({ kind: "session", ...inst })) },
);
const eventArb = fc.oneof({ weight: 4, arbitrary: fc.nat(2).map((own) => ({ own })) }, { weight: 1, arbitrary: fc.constantFrom(...EVENTS) });
const crashArb = fc.oneof({ weight: 8, arbitrary: fc.constant("none") }, { weight: 2, arbitrary: fc.constantFrom(...CRASHES.slice(1)) });
const commandArb = fc.oneof(
  { weight: 10, arbitrary: fc.tuple(whoArb, eventArb, crashArb).map(([who, event, crash]) => new Advance(who, event, crash)) },
  { weight: 2, arbitrary: fc.constant(new Confirm()) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...INSTANCES), fc.boolean()).map(([inst, up]) => new Member(inst.role, inst.index, up)) },
  { weight: 1, arbitrary: fc.constant(new LaunchFails()) },
  { weight: 1, arbitrary: fc.constant(new RestartIdle()) },
);

test("pattern-run handoffs match the model under random advances, crashes and restarts", async () => {
  await fc.assert(fc.asyncProperty(fc.commands([commandArb], { maxCommands: 20, ...(process.env.FC_REPLAY ? { replayPath: process.env.FC_REPLAY } : {}) }), async (cmds) => {
    const dir = tempDir({ after }, "pattern-run-model-");
    const real = makeReal(dir);
    try {
      await startReal(real);
      const model = initialModel();
      checkInvariants(model, real);
      await fc.asyncModelRun(() => ({ model, real }), cmds);
      await driveToEnd(model, real);
    } finally {
      await real.durable?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }), { numRuns: NUM_RUNS, ...SEED });
});
