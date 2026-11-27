// Regression for the pattern-run model counterexample [Advance(operator, split), Advance(worker#1, help), Advance(operator, help)].
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitDecided, decide } from "../lib/pattern-runs.ts";

const definition = {
  name: "live-token",
  roles: [
    { id: "lead", responsibility: "Split the work.", harness: "claude" },
    { id: "worker", responsibility: "Build one part.", harness: "claude", count: 2 },
  ],
  handoffs: [
    { from: "lead", to: "worker", on: "split", kind: "broadcast" },
    { from: "worker", to: "lead", on: "help", kind: "broadcast" },
    { from: "lead", to: "done", on: "skip" },
  ],
};

function advance(run, on, caller, override) {
  return commitDecided(run, decide(run, on, caller, override), { on, note: "", override, by: override ? "operator" : "", caller, now: () => 1 });
}

test("a handoff into an instance that is already live keeps one token for it", () => {
  const run = {
    id: "livetok1", definition, task: "t", status: "running", active: "lead", live: [{ role: "lead", index: 0 }],
    instances: { lead: ["claude#1"], worker: ["claude#2", "claude#3"] }, sessions: { lead: "claude#1", worker: "claude#2" },
    arrivals: {}, visits: { lead: [1] }, handoffs: [],
  };
  advance(run, "split", "", true);
  advance(run, "help", "claude#3", false);
  advance(run, "help", "", true);
  assert.deepEqual(run.live, [{ role: "lead", index: 0 }]);
  advance(run, "split", "", true);
  assert.equal(run.handoffs.at(-1).instance, "0", "the override advanced lead instance 0 once");
});
