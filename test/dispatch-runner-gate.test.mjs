import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../web/server/dispatch.mjs";
import { listenControl } from "../runner/control.mjs";
import { runnerUp } from "../runner/client.mjs";

// A dispatcher tick runs one OpenCode probe before any project; a counted probe shows whether a tick ran.
function probeCounter(skip) {
  let probes = 0;
  const dispatcher = createDispatcher({
    projects: () => [],
    opencode: async () => { probes += 1; return { ok: false }; },
    skip,
  });
  return { dispatcher, probes: () => probes };
}

test("the dispatcher stands down while the runner answers its control socket and runs when it is down", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-gate-"));
  const socket = path.join(dir, "runner.sock");
  const fakeRunner = { harnesses: async () => [] };
  const up = () => runnerUp({ socket });

  assert.equal(await up(), false, "no runner on the socket");
  const counter = probeCounter(up);
  await counter.dispatcher.tick();
  assert.equal(counter.probes(), 1, "dispatcher ticks while the runner is down");

  const control = await listenControl(fakeRunner, socket);
  try {
    assert.equal(await up(), true);
    await counter.dispatcher.tick();
    assert.equal(counter.probes(), 1, "dispatcher stands down while the runner is up");
  } finally {
    await control.close();
  }

  assert.equal(await up(), false);
  await counter.dispatcher.tick();
  assert.equal(counter.probes(), 2, "dispatcher resumes once the runner is down again");
});

test("a skip check that throws leaves the dispatcher running", async () => {
  const counter = probeCounter(() => { throw new Error("probe broke"); });
  await counter.dispatcher.tick();
  assert.equal(counter.probes(), 1);
});
