import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseWireEnvelope } from "../lib/agui.ts";
import { loadConfig } from "../lib/config.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const TO_CODEX = "ai-collab-demo--to--codex";

function setup(t, fake) {
  const home = tempDir(fileEnd, "ai-collab-restart-resume-");
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
  return { env, cfg, db: path.join(home, "state", "runner.db") };
}

const makeRunner = (ctx, adapter) => createRunner({ projects: [ctx.cfg], adapters: new Map([[adapter.harness, adapter]]), durable: openDurable(ctx.db), env: ctx.env, startGapMs: 0, watch: false });

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
const spawnInput = (prompt, parent) => ({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });

// Runs `first` until the child is mid-run (or stalled), stops it, and boots a second runner on the same state.
async function restartMidRun(t, prompt, { stall = false } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const firstAdapter = createFakeAdapter({ harness: "codex" });
  let kill = null;
  if (stall) {
    const open = firstAdapter.open.bind(firstAdapter);
    firstAdapter.open = async (...args) => {
      const handle = await open(...args);
      const send = handle.send.bind(handle);
      handle.send = (message) => (message.text.startsWith(prompt) ? new Promise((_resolve, reject) => { kill = reject; }) : send(message));
      return handle;
    };
  }
  const first = makeRunner(ctx, firstAdapter);
  await first.boot();
  const parent = (await first.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  const { session } = await first.start(spawnInput(prompt, parent));
  if (stall) {
    await until(() => kill, "stalled send");
    const stopping = first.stop();
    kill(new Error("harness killed"));
    await stopping;
  } else {
    await until(() => first.get(session).run, "run").finally(() => first.stop());
  }
  const adapter = createFakeAdapter({ harness: "codex" });
  const second = makeRunner(ctx, adapter);
  t.after(() => second.stop());
  await second.boot();
  return { fake, adapter, second, session };
}

test("a restart mid-run resumes a spawned child with a continue prompt and reports only its real result", async (t) => {
  const { fake, adapter, second, session } = await restartMidRun(t, "hang until cut");
  const sent = await until(() => reports(fake).length && reports(fake), "report");
  await second.settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /finished \(success\)/);
  assert.match(adapter.calls.find((c) => c.op === "send").text, /^The runner restarted during your last turn/);
  assert.equal(second.get(session).restartResumes, undefined);
});

test("a restart before the harness accepts a spawned child's prompt sends the prompt again", async (t) => {
  const { fake, adapter, second } = await restartMidRun(t, "stall before accepting", { stall: true });
  const sent = await until(() => reports(fake).length && reports(fake), "report");
  await second.settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /finished \(success\)/);
  assert.match(adapter.calls.find((c) => c.op === "send").text, /^stall before accepting/);
});
