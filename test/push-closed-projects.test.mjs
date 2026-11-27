import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { askQuestion } from "../lib/questions.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a closed or deleted project sends no push for its new questions", async (t) => {
  const ntfy = await startFakeNtfy();
  t.after(() => ntfy.close());
  const root = tempDir(t, "ai-collab-silent-root-");
  const xdg = tempDir(t, "ai-collab-silent-xdg-");
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  writeFileSync(path.join(xdg, "ai-collab", "projects.json"), JSON.stringify([{ project: "demo", root }]));
  const env = { ...peerEnv(ntfy, { peer: "alice" }), XDG_CONFIG_HOME: xdg };
  const bob = { ...loadConfig(peerEnv(ntfy, { peer: "bob" })), session: "0000000000000001" };
  const sent = [];
  const push = { notify: async (id, payload) => { sent.push(payload.body); return {}; } };
  const ui = createUi({ cfg: loadConfig(env), env, push });
  t.after(() => ui.close());
  const post = (action, body) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), action);

  await askQuestion(bob, "Open project?", { seconds: 0 });
  await until(() => sent.includes("Open project?"));

  assert.equal((await post("close", { project: "demo" })).status, 200);
  await askQuestion(bob, "Closed project?", { seconds: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sent.includes("Closed project?"), false);

  assert.equal((await post("reopen", { project: "demo" })).status, 200);
  assert.equal((await post("delete", { project: "demo" })).status, 200);
  await askQuestion(bob, "Deleted project?", { seconds: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sent.includes("Deleted project?"), false);
});
