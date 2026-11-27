import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { readOwned, writeOwned } from "../lib/sessions/registry.ts";
import { MANAGED_ENV } from "../lib/subagent-guard.ts";
import { PROMPT_MAX_CHARS } from "../lib/sessions/launch.ts";
import { spawnBriefNote, spawnSelfNote } from "../lib/spawn.ts";
import { listSessions } from "../lib/sessions.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { route } from "../runner/control.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

// The parent is a live owned session the runner started, so its address is known only at run time.
const TO_CODEX = "ai-collab-demo--to--codex";

// A throwaway HOME with projects.json, a state dir and a durable log, as test/runner.test.mjs sets up.
function setup(t, fake) {
  const home = tempDir(fileEnd, "ai-collab-runner-spawn-");
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
}, { startTimeoutMs: 1000 }));

// Wraps each opened handle's send so a prompt starting with `prefix` meets `onSend` instead of the fake harness.
function interceptSend(adapter, prefix, onSend) {
  const open = adapter.open.bind(adapter);
  adapter.open = async (...args) => {
    const handle = await open(...args);
    const send = handle.send.bind(handle);
    handle.send = (message) => (message.text.startsWith(prefix) ? onSend(message) : send(message));
    return handle;
  };
}

test("a prompt the harness never accepts reports the error to the parent", (t) => withRunner(t, async ({ fake, runner, adapter }) => {
  interceptSend(adapter, "undeliverable", async () => { throw new Error("harness gone"); });
  await runner.start(spawnInput("undeliverable brief"));
  const sent = await until(() => reports(fake).length && reports(fake), "report");
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /finished \(error\)/);
  assert.match(sent[0].body, /input not delivered: harness gone/);
}));

test("a restart before the harness accepts the prompt reports interrupted", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  // The stalled send settles only once the stop has begun, as a killed harness's would.
  let kill = null;
  interceptSend(adapter, "stall", () => new Promise((_resolve, reject) => { kill = reject; }));
  const first = makeRunner(ctx, adapter);
  await first.boot();
  PARENT = (await first.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  await first.start(spawnInput("stall before accepting"));
  await until(() => kill, "stalled send");
  const stopping = first.stop();
  kill(new Error("harness killed"));
  await stopping;
  const second = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  try {
    await second.boot();
    await second.settle();
    const sent = await until(() => reports(fake).length && reports(fake), "report");
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /finished \(interrupted\)/);
  } finally {
    await second.stop();
  }
});

test("a resume takes managed from the durable workflow input, not the owned record file", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const first = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  await first.boot();
  PARENT = (await first.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  const { session } = await first.start(spawnInput("first turn"));
  await until(() => reports(fake).length === 1, "first report").finally(() => first.stop());
  // The session itself can write its owned record; turning managed off there must not reach the harness.
  const label = session.split("#")[1];
  writeOwned(ctx.cfg, { ...readOwned(ctx.cfg, label), managed: false });
  const adapter = createFakeAdapter({ harness: "codex" });
  const resumed = [];
  const resume = adapter.resume.bind(adapter);
  adapter.resume = (record, rctx, env) => { resumed.push({ managed: record.managed, env: env?.[MANAGED_ENV] }); return resume(record, rctx, env); };
  const second = makeRunner(ctx, adapter);
  try {
    await second.boot();
    await second.send(session, { text: "second turn" });
    await until(() => resumed.length, "resume");
    assert.deepEqual(resumed[0], { managed: true, env: "1" });
  } finally {
    await second.stop();
  }
});

test("a parent closes its own spawned child, which frees a slot under the cap", (t) => withRunner(t, async ({ runner }) => {
  const children = [];
  for (let i = 0; i < 4; i++) children.push((await runner.start(spawnInput(`child ${i}`))).session);
  await assert.rejects(runner.start(spawnInput("fifth")), { status: 429 });
  const [harness, label] = children[0].split("#");
  const [status, closed] = await route(runner, "POST", new URL(`http://runner/v1/sessions/${harness}/${label}/close-child`), { parent: PARENT });
  assert.equal(status, 200);
  assert.equal(closed.status, "ended");
  assert.equal((await runner.start(spawnInput("fifth"))).status, "started");
}));

test("close-child refuses a session that is not the caller's spawned child", (t) => withRunner(t, async ({ runner }) => {
  const child = (await runner.start(spawnInput("child"))).session;
  await assert.rejects(runner.closeChild(child, "claude#0123456789abcdef"), { status: 403 });
  await assert.rejects(runner.closeChild(PARENT, PARENT), { status: 403 });
  assert.notEqual(runner.get(child).status, "ended");
}));

test("a spawn brief counts both spawn notes against the 4000-character prompt limit", (t) => withRunner(t, async ({ runner, adapter }) => {
  const overhead = spawnBriefNote("x", PARENT).length - 1 + spawnSelfNote(`codex#${"0".repeat(16)}`).length;
  const longest = PROMPT_MAX_CHARS - overhead;
  await assert.rejects(runner.start(spawnInput("y".repeat(longest + 1))), { status: 400 });
  await runner.start(spawnInput("z".repeat(longest)));
  const first = await until(() => adapter.calls.filter((c) => c.op === "send").map((c) => c.text).find((text) => text.startsWith("zzz")), "first prompt");
  assert.equal(first.length, PROMPT_MAX_CHARS);
}));
