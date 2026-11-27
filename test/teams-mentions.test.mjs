import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox } from "../lib/messaging.ts";
import { recordSession } from "../lib/sessions/registry.ts";
import { createUi, mentionedNames, mentionedTeams } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8797";

test("mentionedTeams finds @team tags without treating them as harness peers", () => {
  assert.deepEqual(mentionedTeams("@light-team ship it and @codex help", ["light-team"]), ["light-team"]);
  assert.deepEqual(mentionedNames("@light-team and @codex", ["claude", "codex"], ["light-team"]), ["codex"]);
});

test("@team from project chat starts a claude orchestrator with roster instructions", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-team-mention-");
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n");
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "claude"), 0o755);
  chmodSync(path.join(bin, "codex"), 0o755);
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: fake.url, peers: "claude,codex", teams: { "light-team": ["codex", "claude:haiku"] } },
  ]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex" }), HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const starts = [];
  const ui = createUi({
    cfg, env,
    models: async () => ({ claude: ["haiku", "sonnet"], codex: ["gpt-5"] }),
    start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; },
  });
  t.after(() => ui.close());
  const send = (body, target = "all") => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body }),
  }), "send").then((r) => r.json());

  const broadcast = await send("@light-team build the feature");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].harness, "claude");
  assert.match(starts[0].prompt, /orchestrator for team "light-team"/);
  assert.match(starts[0].prompt, /codex/);
  assert.match(broadcast.detail, /@light-team starting a new session/);
});

test("@team in a session chat messages that session as orchestrator", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-team-direct-");
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: fake.url, peers: "claude,codex", teams: { crew: ["codex"] } },
  ]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex" }), HOME: home };
  const cfg = loadConfig(env);
  const claude = { ...loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), session: sessionLabel("c1") };
  await recordSession(claude, { id: "c1", cwd: home, harness: "claude", event: "SessionStart" });
  const target = `claude#${claude.session}`;
  const ui = createUi({ cfg, env, start: async () => ({ status: "starting" }) });
  t.after(() => ui.close());
  await ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ target, body: "@crew split the work" }),
  }), "send");
  const inbox = await claimInbox(claude);
  const orch = inbox.find((m) => m.forTeam === "crew");
  assert.ok(orch, "orchestrator message");
  assert.match(orch.body, /orchestrator for team "crew"/);
});
