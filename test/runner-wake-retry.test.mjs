// A wake send that certainly did not start a turn is retried a bounded number of times: the case is a codex thread
// still closing when the wake resumes it. A retryable refusal is retried on a fresh resume; an exhausted one releases
// the batch to the hooks; an error that may have started the turn is never retried.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sessionLabel } from "../lib/config.mjs";
import { reserveOwned } from "../lib/inbox.mjs";
import { permissionSettings } from "../runner/contract.mjs";
import codexAdapter from "../runner/adapters/codex.mjs";
import { WAKE, WAKE_SEND_ATTEMPTS } from "../runner/runner.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";

const HELPER = fileURLToPath(new URL("./helpers/fake-codex-app-server.mjs", import.meta.url));
const CODEX = { file: process.execPath, args: [HELPER, "app-server"], version: ["--version"] };

const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });
const published = (fake, text) => fake.state.publishes.some((p) => JSON.stringify(p).includes(text));
const attempts = (adapter) => adapter.calls.filter((c) => c.op === "resume").length;

/** The adapter whose resumed handle refuses its first `refusals` sends with `error`, then delegates to the base handle. */
function wrapFirstSends(adapter, refusals, error) {
  const baseResume = adapter.resume;
  let refused = 0;
  return {
    ...adapter,
    resume: async (record, ctx, env) => {
      const handle = await baseResume(record, ctx, env);
      return {
        ...handle,
        send: async (input) => {
          if (refused < refusals) {
            refused += 1;
            throw error;
          }
          return handle.send(input);
        },
      };
    },
  };
}

// A closed owned session: the state a wake starts from.
async function closedSession(runner) {
  const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
  await until(() => runner.get(session).status === "idle", "idle");
  await runner.close(session);
  await until(() => runner.get(session).status === "ended", "ended");
  return { session, label: sessionLabel(nativeId) };
}

test("a wake send refused as retryable is resumed and retried, then delivers the batch once", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = wrapFirstSends(createFakeAdapter({ harness: "codex" }), 1, Object.assign(new Error("thread is closing"), { retryable: true }));
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, label } = await closedSession(runner);

    const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "wake up please"));
    const wakeId = `${WAKE}:${session}:${ev.id}`;
    await until(() => durable.status(wakeId)?.status === "SUCCESS", "wake", 10_000);

    assert.equal(attempts(adapter), 2, "the refused attempt resumes again before its retry");
    const sends = adapter.calls.filter((c) => c.op === "send" && /wake up please/.test(c.text));
    assert.equal(sends.length, 1, "the retry delivered the batch once");
    const step = durable.steps(wakeId).find((s) => s.name === "wake.send");
    assert.equal(JSON.parse(step.output).attempts, 2, "the step records its attempts");
    assert.equal(published(fake, "did not take the message"), false);
    assert.equal(published(fake, "not resent"), false);
    // Delivered: a later claim cannot take the message again.
    const probe = await reserveOwned({ ...ctx.cfg, peer: "codex", session: label }, [ev.id], { owner: "probe" });
    assert.equal(probe.owned.includes(ev.id), false, "the message is marked delivered");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a wake send refused as retryable every time stops at WAKE_SEND_ATTEMPTS and releases the batch", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = wrapFirstSends(createFakeAdapter({ harness: "codex" }), Number.MAX_SAFE_INTEGER, Object.assign(new Error("thread is closing"), { retryable: true }));
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, label } = await closedSession(runner);

    const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "wake up please"));
    const wakeId = `${WAKE}:${session}:${ev.id}`;
    await until(() => durable.status(wakeId)?.status === "SUCCESS", "wake", 10_000);

    assert.equal(attempts(adapter), WAKE_SEND_ATTEMPTS, "the retries are bounded");
    assert.equal(published(fake, `did not take the message after ${WAKE_SEND_ATTEMPTS} attempts: thread is closing`), true);
    // Released: the hooks can take the message again.
    const probe = await reserveOwned({ ...ctx.cfg, peer: "codex", session: label }, [ev.id], { owner: "probe" });
    assert.equal(probe.owned.includes(ev.id), true, "the message is released to the hooks");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a wake send that may have started the turn is never retried", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const ambiguous = Object.assign(new Error("codex turn/start timed out"), { mayHaveStarted: true, retryable: true });
  const adapter = wrapFirstSends(createFakeAdapter({ harness: "codex" }), Number.MAX_SAFE_INTEGER, ambiguous);
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, label } = await closedSession(runner);

    const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "wake up please"));
    await until(() => durable.status(`${WAKE}:${session}:${ev.id}`)?.status === "SUCCESS", "wake");

    assert.equal(attempts(adapter), 1, "one attempt, no retry");
    assert.equal(published(fake, "may have taken the message; not resent: codex turn/start timed out"), true);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

// The real adapter over the scripted app-server: an error response from turn/start is retryable, since the server
// refused the request and ran nothing. A timed-out request is not (see the tests above).
test("the codex adapter marks a refused turn/start retryable but never a timed-out one", async () => {
  const adapter = codexAdapter({ command: CODEX, requestMs: 5000 });
  const ctx = { emit: () => {}, log: () => {}, signal: new AbortController().signal };
  const options = {
    project: "p", cwd: os.tmpdir(), place: "folder", permissionMode: "auto",
    permission: permissionSettings("codex", "auto", "folder").settings,
    env: { PATH: process.env.PATH, FAKE_CODEX_CLOSING_TIMES: "1" },
  };
  try {
    const handle = await adapter.open(options, ctx);
    await assert.rejects(handle.send({ text: "closing thread, please wake" }), (error) => {
      assert.match(error.message, /thread is closing/);
      assert.equal(error.retryable, true);
      assert.equal(error.mayHaveStarted, undefined);
      return true;
    });
    // The same handle's next send is answered normally: the retry the runner would make succeeds.
    const { runId } = await handle.send({ text: "closing thread, please wake" });
    assert.match(runId, /^turn-/);
    await handle.close();
  } finally {
    await adapter.shutdown();
  }
});

