import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { readOwned } from "../lib/sessions/registry.ts";
import { listSessions } from "../lib/sessions.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

// The parent is a live owned session the runner started, so its address is known only at run time.
const TO_CODEX = "ai-collab-demo--to--codex";

// A throwaway HOME with projects.json, a state dir and a durable log, as test/runner.test.mjs sets up.
function setup(t, fake) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-runner-spawn-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  assert.equal(cfg.enabled, true, cfg.reason);
  return { home, root, env, cfg, db: path.join(home, "state", "runner.db") };
}

function makeRunner(ctx, adapter, { startGapMs = 0, startTimeoutMs } = {}) {
  return createRunner({ projects: [ctx.cfg], adapters: new Map([[adapter.harness, adapter]]), durable: openDurable(ctx.db), env: ctx.env, startGapMs, watch: false, ...(startTimeoutMs ? { startTimeoutMs } : {}) });
}

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const reports = (fake) => fake.state.publishes.filter((p) => p.topic === TO_CODEX).map((p) => parseWireEnvelope(p.message)).filter((e) => e?.body?.startsWith("[spawn_agent]"));
let PARENT = "";
const spawnInput = (prompt, parent = PARENT) => ({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });

async function withRunner(t, run, options = {}) {
  const fake = await startFakeNtfy();
  const ctx = setup(t, fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter, options);
  await runner.boot();
  try {
    PARENT = (await runner.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
    await run({ fake, ctx, adapter, runner });
  } finally {
    await runner.stop();
    await fake.close();
  }
}

test("a spawn returns at once and records managed, parent and depth on the owned record and registry", (t) => withRunner(t, async ({ ctx, runner, adapter }) => {
  const started = await runner.start(spawnInput("say hi"));
  assert.equal(started.status, "started");
  assert.equal(started.cwd, ctx.root);
  const label = started.session.split("#")[1];
  const record = readOwned(ctx.cfg, label);
  assert.equal(record.managed, true);
  assert.equal(record.parent, PARENT);
  assert.deepEqual(record.spawn, { depth: 1 });
  assert.equal(listSessions(ctx.cfg).find((s) => s.id === started.session)?.parent, PARENT);
  assert.equal(adapter.calls.filter((c) => c.op === "open").at(-1).options.managed, true);
}));

test("each finished run of a spawned child reports to its parent from the child's address", (t) => withRunner(t, async ({ fake, runner }) => {
  const { session } = await runner.start(spawnInput("say hi"));
  const [first] = await until(() => reports(fake).length >= 1 && reports(fake), "first report");
  const label = session.split("#")[1];
  assert.equal(first.from, "codex");
  assert.equal(first.session, label);
  assert.equal(first.to, "codex");
  assert.equal(first.toSession, PARENT.split("#")[1]);
  assert.match(first.body, new RegExp(`^\\[spawn_agent\\] ${session} finished \\(success\\):\\necho: say hi`));
  assert.match(first.body, new RegExp(`You were started by ${PARENT}`));
  assert.notEqual(first.priority, "fyi");
  await until(() => runner.get(session).status === "idle", "idle");
  await runner.send(session, { text: "again" });
  const second = await until(() => reports(fake)[1], "second report");
  assert.match(second.body, /finished \(success\):\necho: again/);
}));

test("an interrupted run reports cancelled", (t) => withRunner(t, async ({ fake, runner }) => {
  const { session } = await runner.start(spawnInput("hang please"));
  await until(() => runner.get(session).status === "running", "running");
  await runner.interrupt(session);
  const report = await until(() => reports(fake)[0], "report");
  assert.match(report.body, /finished \(cancelled\):\n\(no reply text\)$/);
}));

test("a parent gets at most 4 live children, and a chain stops at depth 2", (t) => withRunner(t, async ({ runner }) => {
  const children = [];
  for (let i = 0; i < 4; i++) children.push((await runner.start(spawnInput(`child ${i}`))).session);
  await assert.rejects(runner.start(spawnInput("child 5")), { status: 429, message: /already has 4 live spawned agents/ });
  const grandchild = (await runner.start(spawnInput("deeper", children[0]))).session;
  await assert.rejects(runner.start(spawnInput("too deep", grandchild)), { status: 409, message: "spawn depth limit reached" });
  await runner.close(children[1]);
  await until(() => runner.get(children[1]).status === "ended", "ended");
  assert.equal((await runner.start(spawnInput("replacement"))).status, "started");
}));

test("spawns skip the start gap; plain starts keep it", (t) => withRunner(t, async ({ runner, adapter }) => {
  assert.equal((await runner.start(spawnInput("one"))).status, "started");
  assert.equal((await runner.start(spawnInput("two"))).status, "started");
  await assert.rejects(runner.start({ project: "demo", harness: "codex", prompt: "plain again" }), { status: 429 });
  const plain = adapter.calls.find((c) => c.op === "open").options;
  assert.equal(plain.managed, undefined);
}, { startGapMs: 10_000 }));

test("a spawn with a malformed parent is refused", (t) => withRunner(t, async ({ runner }) => {
  await assert.rejects(runner.start(spawnInput("hi", "bogus")), { status: 400, message: "Invalid parent address" });
  await assert.rejects(runner.start({ ...spawnInput("hi"), parent: undefined }), { status: 400 });
}));

test("a spawn's brief that already names the parent gets no added line", (t) => withRunner(t, async ({ runner, adapter }) => {
  const { session } = await runner.start(spawnInput(`report to ${PARENT} when done`));
  await until(() => adapter.calls.filter((c) => c.op === "send").length === 2, "send");
  const text = adapter.calls.filter((c) => c.op === "send")[1].text;
  assert.ok(text.startsWith(`report to ${PARENT} when done`));
  assert.ok(!text.includes("You were started by"));
  assert.match(text, new RegExp(`your address is ${session}`));
}));

test("a restart mid-run sends one interrupted report and no success report", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const first = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  await first.boot();
  PARENT = (await first.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  const { session } = await first.start(spawnInput("hang until cut"));
  await until(() => first.get(session).run, "run").finally(() => first.stop());
  const second = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  try {
    await second.boot();
    await until(() => second.get(session).cut, "cut");
    await second.settle();
    const sent = await until(() => reports(fake).length && reports(fake), "report");
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /finished \(interrupted\)/);
  } finally {
    await second.stop();
  }
});

test("a spawn whose parent is not a live session is refused, so a forged label cannot reset the depth", (t) => withRunner(t, async ({ runner }) => {
  await assert.rejects(runner.start(spawnInput("d3", "codex#0123456789abcdef")), { status: 409, message: "spawn parent is not a live session" });
  const child = (await runner.start(spawnInput("child"))).session;
  await runner.close(child);
  await until(() => runner.get(child).status === "ended", "ended");
  await assert.rejects(runner.start(spawnInput("orphan", child)), { status: 409, message: "spawn parent is not a live session" });
}));

test("a spawned child's first prompt names its own address and session label", (t) => withRunner(t, async ({ runner, adapter }) => {
  const { session } = await runner.start(spawnInput("say hi"));
  await until(() => adapter.calls.filter((c) => c.op === "send").length === 2, "send");
  const text = adapter.calls.filter((c) => c.op === "send")[1].text;
  assert.match(text, new RegExp(`your address is ${session}; pass session "${session.split("#")[1]}"`));
}));

test("a spawn that times out is cancelled, so no child runs and the cap stays free", (t) => withRunner(t, async ({ runner, adapter }) => {
  const open = adapter.open.bind(adapter);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  adapter.open = async (...args) => { await gate; return open(...args); };
  await assert.rejects(runner.start(spawnInput("slow child")), { status: 504 });
  release();
  adapter.open = open;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(adapter.calls.filter((c) => c.op === "send").length, 1, "only the parent's prompt was sent");
  for (let i = 0; i < 4; i++) assert.equal((await runner.start(spawnInput(`child ${i}`))).status, "started");
}, { startTimeoutMs: 150 }));
