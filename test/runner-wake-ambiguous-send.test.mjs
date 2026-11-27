// A wake whose harness send may have started the turn marks its batch delivered and never releases it for a resend.
import test from "node:test";
import assert from "node:assert/strict";
import { sessionLabel } from "../lib/config.ts";
import { reserveOwned } from "../lib/messaging.ts";
import { WAKE } from "../runner/runner.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { wrapSendError } from "./helpers/fake-adapter-hooks.mjs";

const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });
const published = (fake, text) => fake.state.publishes.some((p) => JSON.stringify(p).includes(text));

test("a wake whose send may have started the turn marks the message delivered, not released", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const base = createFakeAdapter({ harness: "codex" });
  const sendError = Object.assign(new Error("codex turn/start timed out"), { mayHaveStarted: true });
  const adapter = wrapSendError(base, sendError);
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    await until(() => runner.get(session).status === "idle", "idle");
    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");

    const label = sessionLabel(nativeId);
    const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "wake up please"));
    await until(() => durable.status(`${WAKE}:${session}:${ev.id}`)?.status === "SUCCESS", "wake");

    assert.equal(published(fake, "may have taken the message; not resent: codex turn/start timed out"), true);
    assert.equal(published(fake, "did not take the message"), false);
    // A released id is free for the next claim; a delivered id is not.
    const probe = await reserveOwned({ ...ctx.cfg, peer: "codex", session: label }, [ev.id], { owner: "probe" });
    assert.equal(probe.owned.includes(ev.id), false, "the message is not released for a resend");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a wake whose send did not start releases the message for the hooks", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const base = createFakeAdapter({ harness: "codex" });
  const adapter = wrapSendError(base, new Error("codex app-server exited"));
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    await until(() => runner.get(session).status === "idle", "idle");
    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");

    const label = sessionLabel(nativeId);
    const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "wake up please"));
    await until(() => durable.status(`${WAKE}:${session}:${ev.id}`)?.status === "SUCCESS", "wake");

    assert.equal(published(fake, "did not take the message"), true);
    const probe = await reserveOwned({ ...ctx.cfg, peer: "codex", session: label }, [ev.id], { owner: "probe" });
    assert.equal(probe.owned.includes(ev.id), true, "the message is released to the hooks");
  } finally {
    await runner.stop();
    await fake.close();
  }
});
