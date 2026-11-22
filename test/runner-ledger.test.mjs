import test from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { readDispatchLedger, writeDispatchLedger } from "../lib/deliver-push.mjs";
import { DELIVERY } from "../runner/delivery.mjs";

test("an expect-reply message the dispatcher delivered keeps its redelivery once the runner owns it", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const address = "codex#0123456789abcdef";
  const message = { id: "m-ledger", from: "operator", to: "codex", toSession: "0123456789abcdef", body: "answer me", expectReply: true };
  writeDispatchLedger(ctx.cfg, { "m-ledger": { address, from: "operator", firstAt: Date.now(), lastAt: Date.now(), attempts: 1, message } });

  const pushes = [];
  const { runner, durable } = makeRunner(ctx, [], {
    delivery: {
      redeliverMs: 20,
      readyPollMs: 5,
      sessionOf: () => ({ id: address, harness: "codex", online: true, peer: "codex", session: "0123456789abcdef" }),
      ready: async () => true,
      push: async (session, { text }) => { pushes.push(text); return { status: "delivered" }; },
      acked: async () => false,
    },
  });
  await runner.boot();
  try {
    const started = await runner.pump();
    const id = `${DELIVERY}:${address}:m-ledger`;
    assert.ok(started.includes(id), `pump started ${started.join(", ")}`);
    const out = await until(() => durable.status(id)?.status === "SUCCESS" && durable.status(id).output, "redelivery");
    assert.deepEqual(out, { status: "dropped", pushes: 5 });
    // Attempts 2 to 5 go out; the first push was the dispatcher's.
    assert.equal(pushes.length, 4);
    assert.equal(readDispatchLedger(ctx.cfg)["m-ledger"], undefined, "the ledger entry moved to the runner");
  } finally {
    await runner.stop();
    await fake.close();
  }
});
