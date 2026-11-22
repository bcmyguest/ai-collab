import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";

test("a project with no projects.json entry is listed under autoProjects; a registered one is not", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const root = mkdtempSync(path.join(os.tmpdir(), "ai-collab-auto-root-"));
  const xdg = mkdtempSync(path.join(os.tmpdir(), "ai-collab-auto-xdg-"));
  const env = { ...peerEnv(fake, { peer: "alice" }), XDG_CONFIG_HOME: xdg };
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  const ui = createUi({ cfg: loadConfig(env), env });
  t.after(() => ui.close());
  async function snapshot() {
    const ctrl = new AbortController();
    const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
    const first = (await stream.next()).value;
    ctrl.abort();
    return first.data;
  }

  assert.deepEqual((await snapshot()).autoProjects, ["demo"]);
  writeFileSync(path.join(xdg, "ai-collab", "projects.json"), JSON.stringify([{ project: "demo", root }]));
  assert.deepEqual((await snapshot()).autoProjects, []);
});
