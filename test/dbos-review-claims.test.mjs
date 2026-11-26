// Reviewer finding 7: on DBOS, boot's pending() launches and recovers before the claim waiters exist,
// so a recovered workflow that claims early must have its claim kept for the next take, not dropped.
import assert from "node:assert/strict";
import test from "node:test";
import { createClaims } from "../runner/runner.mjs";

test("a claim arriving before its waiter is delivered to the next take", async () => {
  const claims = createClaims();
  claims.set("early", { id: "early" }); // the recovered workflow claims before boot takes
  assert.deepEqual(await claims.take("early"), { id: "early" });
});

test("a claim arriving after its waiter resolves the waiter", async () => {
  const claims = createClaims();
  const waiting = claims.take("late");
  claims.set("late", { id: "late" });
  assert.deepEqual(await waiting, { id: "late" });
});

test("drop forgets a waiter and an early claim", async () => {
  const claims = createClaims();
  claims.set("gone", 1);
  claims.drop("gone");
  let taken = false;
  claims.take("gone").then(() => { taken = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(taken, false, "a dropped early claim must not reach a later take");
});

test("an early claim nobody takes expires instead of leaking", async () => {
  let clock = 1_000;
  const claims = createClaims({ now: () => clock });
  claims.set("orphan", { id: "orphan" }); // its waiter timed out and dropped before this arrived
  clock += 11 * 60_000;
  claims.set("tick", 1); // any later traffic prunes the stale entry
  let taken = false;
  claims.take("orphan").then(() => { taken = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(taken, false, "a stale unclaimed early claim must be gone, not delivered late");
});
