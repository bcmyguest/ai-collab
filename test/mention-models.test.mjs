import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { recordSession } from "../lib/sessions.mjs";
import { createUi, mentionedNames } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8796";

test("mentionedNames reads @harness:model and drops a trailing full stop", () => {
  assert.deepEqual(mentionedNames("ask @codex:gpt-5-codex. then @opencode:openai/gpt-5 and @mallory:x", ["codex", "opencode"]),
    ["codex:gpt-5-codex", "opencode:openai/gpt-5"]);
});

test("an @harness:model post starts a session with that model, after checking the model list", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-mention-model-");
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "codex"), 0o755);
  const stateDir = path.join(home, "state");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex" }), HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const claude = { ...loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), session: sessionLabel("c1") };
  await recordSession(claude, { id: "c1", cwd: home, harness: "claude", event: "SessionStart" });
  const target = `claude#${claude.session}`;
  const starts = [];
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-5-codex", "gpt-5"] }), start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; } });
  t.after(() => ui.close());
  const send = (body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body }),
  }), "send").then(r => r.json());

  const unknown = await send("@codex:xyz do X");
  assert.equal(starts.length, 0);
  assert.match(unknown.detail, /@codex:xyz unknown model/);

  const first = await send("@codex:gpt-5-codex do X");
  assert.deepEqual(starts, [{ harness: "codex", model: "gpt-5-codex", prompt: "@codex:gpt-5-codex do X", env, place: "folder" }]);
  assert.match(first.detail, /@codex:gpt-5-codex starting a new session/);

  const second = await send("@codex:gpt-5 do Y");
  assert.equal(starts.length, 1, "the start gap holds for model mentions");
  assert.match(second.detail, /@codex:gpt-5: wait 10 seconds between starts/);
});
