import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { parseWireEnvelope } from "../lib/agui.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { gitRepo, makeRunner as makeCtxRunner, setup as setupCtx, until } from "./helpers/runner-ctx.mjs";

const TO_CODEX = "ai-collab-demo--to--codex";

// The shared runner test home, removed after the test.
function setup(t, fake) {
  const ctx = setupCtx(fake);
  gitRepo(ctx.root);
  t.after(() => rmSync(ctx.home, { recursive: true, force: true }));
  return ctx;
}

const makeRunner = (ctx, adapter) => makeCtxRunner(ctx, [adapter]).runner;

const reports = (fake) => fake.state.publishes.filter((p) => p.topic === TO_CODEX).map((p) => parseWireEnvelope(p.message)).filter((e) => e?.body?.startsWith("[spawn_agent]"));
const spawnInput = (prompt, parent) => ({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });

// Runs `first` until the child is mid-run (or stalled), stops it, and boots a second runner on the same state.
async function restartMidRun(t, prompt, { stall = false } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const firstAdapter = createFakeAdapter({ harness: "codex", capabilities: { places: ["folder", "worktree", "openshell"], openshellStarts: true } });
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
  const parent = (await first.start({ project: "demo", harness: "codex", prompt: "parent", place: "folder" })).session;
  const { session } = await first.start(spawnInput(prompt, parent));
  if (stall) {
    await until(() => kill, "stalled send");
    const stopping = first.stop();
    kill(new Error("harness killed"));
    await stopping;
  } else {
    await until(() => first.get(session).run, "run").finally(() => first.stop());
  }
  const adapter = createFakeAdapter({ harness: "codex", capabilities: { places: ["folder", "worktree", "openshell"], openshellStarts: true } });
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

test("a restart before the harness accepts a spawned child's prompt sends the prompt again behind a check-first note", async (t) => {
  const { fake, adapter, second } = await restartMidRun(t, "stall before accepting", { stall: true });
  const sent = await until(() => reports(fake).length && reports(fake), "report");
  await second.settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /finished \(success\)/);
  const text = adapter.calls.find((c) => c.op === "send").text;
  assert.match(text, /^The runner restarted during your last turn/);
  assert.match(text, /in case it never arrived:\nstall before accepting/);
});
