import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../runner/schedules.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("work a scheduled command starts in the background outlives its clean exit", async () => {
  const result = await runCommand(["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { timeoutMs: 10_000, graceMs: 200 });
  assert.equal(result.ok, true);
  const pid = Number(result.tail.trim());
  assert.ok(pid > 0);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(pid), true, "the handed-off process still runs");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("a background child that keeps the output pipe open does not hold the run open", async () => {
  const started = Date.now();
  const result = await runCommand(["sh", "-c", "sleep 30 & echo $!"], { timeoutMs: 10_000, graceMs: 200 });
  const pid = Number(result.tail.trim());
  try {
    assert.equal(result.ok, true);
    assert.ok(Date.now() - started < 5000, "finishes after the grace, not when the child ends");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});
