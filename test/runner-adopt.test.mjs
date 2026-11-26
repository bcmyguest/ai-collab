import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { procStart, makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { sessionLabel } from "../lib/config.mjs";
import { ownedFile } from "../lib/sessions.ts";
import { recordSession } from "../lib/sessions.mjs";
import { WAKE } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";

const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });

// Registers a closed codex session the runner has not adopted yet.
async function closedCodex(ctx, nativeId) {
  const label = sessionLabel(nativeId);
  await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop" });
  return label;
}

test("a message to the peer as a whole wakes no session, only one addressed to the session", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner, durable } = makeRunner(ctx, [adapter]);
  await runner.boot();
  try {
    await closedCodex(ctx, "codex-peer-wide");
    fake.inject("ai-collab-demo--to--codex", JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", ts: new Date().toISOString(), body: "everyone on codex" }));
    const started = await runner.pump();
    assert.deepEqual(started.filter((id) => id.startsWith(`${WAKE}:`)), []);
    assert.equal(durable.listNamed(WAKE).length, 0);
    assert.equal(adapter.calls.length, 0);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("one pump wakes at most two closed sessions; the rest wait for the next tick", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner } = makeRunner(ctx, [adapter]);
  await runner.boot();
  try {
    for (const nativeId of ["codex-cap-1", "codex-cap-2", "codex-cap-3"]) {
      const label = await closedCodex(ctx, nativeId);
      fake.inject("ai-collab-demo--to--codex", direct(label, `for ${nativeId}`));
    }
    const started = (await runner.pump()).filter((id) => id.startsWith(`${WAKE}:`));
    assert.equal(started.length, 2);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a session the user resumed outside the runner is not woken, and its adopted record is dropped", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner, durable } = makeRunner(ctx, [adapter]);
  await runner.boot();
  const user = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const nativeId = "codex-resumed-1";
    const label = await closedCodex(ctx, nativeId);
    const address = `codex#${label}`;
    const first = fake.inject("ai-collab-demo--to--codex", direct(label, "adopt me"));
    await runner.pump();
    await until(() => durable.status(`${WAKE}:${address}:${first.id}`)?.status === "SUCCESS", "adoption");
    assert.equal(runner.get(address).status, "ended");
    const ownedCfg = { ...ctx.cfg, peer: "codex", session: label };
    assert.ok(existsSync(ownedFile(ownedCfg, label)), "adopted record exists before the user resumes");

    // The user resumes the session in a terminal: its process is online, outside the runner.
    await until(() => user.pid, "child pid");
    await new Promise((r) => setTimeout(r, 50));
    await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop", proc: { pid: user.pid, start: procStart(user.pid) } });

    const second = fake.inject("ai-collab-demo--to--codex", direct(label, "after the user resumed"));
    const started = await runner.pump();
    assert.equal(started.filter((id) => id.startsWith(`${WAKE}:`)).length, 0, "no wake for a session seen online outside the runner");
    assert.equal(durable.status(`${WAKE}:${address}:${second.id}`), null);
    assert.equal(existsSync(ownedFile(ownedCfg, label)), false, "the adopted record is dropped");
  } finally {
    user.kill();
    await runner.stop();
    await fake.close();
  }
});

test("a wake of an owned session that its user resumed outside is skipped and its message left to the hooks", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: true });
  await runner.boot();
  const user = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    await until(() => runner.get(session).status === "idle", "idle");
    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");
    await until(() => user.pid, "child pid");
    await new Promise((r) => setTimeout(r, 50));
    await recordSession({ ...ctx.cfg, peer: "codex", session: sessionLabel(nativeId) }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop", proc: { pid: user.pid, start: procStart(user.pid) } });
    const ev = fake.inject("ai-collab-demo--to--codex", direct(sessionLabel(nativeId), "resumed elsewhere"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(durable.status(`${WAKE}:${session}:${ev.id}`), null);
    assert.equal(adapter.calls.filter((c) => c.op === "resume").length, 0);
  } finally {
    user.kill();
    await runner.stop();
    await fake.close();
  }
});
