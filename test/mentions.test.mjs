import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox } from "../lib/inbox.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { createUi, mentionedNames } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";

test("mentionedNames finds @harness and @session tags of the project's peers", () => {
  const codex = "codex#0123456789abcdef";
  assert.deepEqual(mentionedNames(`@codex and @${codex}, not a@claude or @all or @mallory`, ["claude", "codex"]), ["codex", codex]);
});

test("an @harness post reaches its running session, or starts one with the post as prompt", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-mention-"));
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
  const ui = createUi({ cfg, env, start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; } });
  t.after(() => ui.close());
  const send = (body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body }),
  }), "send").then(r => r.json());

  const first = await send("@codex check that the UI makes sense");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].harness, "codex");
  assert.equal(starts[0].prompt, "@codex check that the UI makes sense");
  assert.match(first.detail, /@codex starting a new session/);

  const codex = { ...loadConfig({ ...env, AI_COLLAB_PEER: "codex" }), session: sessionLabel("x1") };
  // A session counts as running while its recorded process lives: use this test's own process.
  const start = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  await recordSession(codex, { id: "x1", cwd: home, harness: "codex", event: "SessionStart", proc: { pid: process.pid, start } });
  const second = await send("@codex also check the header");
  assert.equal(starts.length, 1, "a running session gets the post instead of a new start");
  assert.match(second.detail, /@codex sent to 1 session/);
  assert.deepEqual((await claimInbox(codex)).map(m => m.body), ["@codex also check the header"]);
});
