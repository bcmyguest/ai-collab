import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

test("close hides a project from the state, reopen shows it, delete drops its registry entry", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const root = tempDir(t, "ai-collab-close-ui-");
  const xdg = tempDir(t, "ai-collab-xdg-");
  const env = { ...peerEnv(fake, { peer: "alice" }), XDG_CONFIG_HOME: xdg };
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  const registry = path.join(xdg, "ai-collab", "projects.json");
  writeFileSync(registry, JSON.stringify([{ project: "demo", root }]));
  const cfg = loadConfig(env);
  const ui = createUi({ cfg, env });
  t.after(() => ui.close());

  const post = (action, body) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), action);
  async function snapshot() {
    const ctrl = new AbortController();
    const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
    const first = (await stream.next()).value;
    ctrl.abort();
    return first.data;
  }

  assert.deepEqual((await snapshot()).projects.map(p => p.id), ["demo"]);
  assert.equal((await post("project-pause", { project: "demo", paused: "true" })).status, 400);
  assert.equal((await post("project-pause", { project: "missing", paused: true })).status, 400);
  assert.equal((await post("project-pause", { project: "demo", paused: true })).status, 200);
  assert.equal((await snapshot()).projects[0].paused, true);
  for (const action of ["start", "continue-builder", "recover-builder"]) {
    assert.equal((await post(action, { project: "demo" })).status, 409);
  }
  assert.equal((await post("history", { query: "" })).status, 200);
  assert.equal((await post("send", { project: "demo", target: "all", body: "Keep reviewing the current work" })).status, 201);
  assert.equal((await post("project-pause", { project: "demo", paused: false })).status, 200);
  assert.equal(Boolean((await snapshot()).projects[0].paused), false);
  assert.equal((await post("start", { project: "demo" })).status, 400);
  assert.equal((await post("close", { project: "demo" })).status, 200);
  const closed = await snapshot();
  assert.deepEqual(closed.projects, []);
  assert.deepEqual(closed.closedProjects, ["demo"]);

  assert.equal((await post("reopen", { project: "demo" })).status, 200);
  const reopened = await snapshot();
  assert.deepEqual(reopened.projects.map(p => p.id), ["demo"]);
  assert.deepEqual(reopened.closedProjects, []);

  assert.equal((await post("delete", { project: "demo" })).status, 200);
  assert.deepEqual((await snapshot()).projects, []);
  assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), []);
  assert.equal((await post("close", { project: "demo" })).status, 404);
});
