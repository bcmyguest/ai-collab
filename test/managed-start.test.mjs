import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startCommand, startSession } from "../lib/start.mjs";
import { loadConfig } from "../lib/config.mjs";
import { runCli } from "../lib/cli.mjs";
import { teamStart } from "../lib/teams.mjs";
import { CLAUDE_NO_SUBAGENT_SETTINGS, MANAGED_ENV } from "../lib/subagent-guard.ts";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "managed-start-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "demo");
  const bin = join(home, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  for (const name of ["claude", "codex", "opencode"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = { HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, ".config"), AI_COLLAB_STATE_DIR: join(home, "state") };
  return { env, cfg: { project: "demo", stateDir: env.AI_COLLAB_STATE_DIR, peers: [] } };
}

// A spawn stand-in that records the argv and env, then exits 0 without printing a session id.
function recorder() {
  const seen = [];
  const run = (file, args, options) => {
    seen.push({ file, args, env: options.env });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  return { seen, run };
}

test("a managed start puts the no-subagent args last before the prompt", () => {
  const claude = startCommand("claude", "/r", "hi", { managed: true });
  assert.deepEqual(claude[1].slice(-3), ["--settings", CLAUDE_NO_SUBAGENT_SETTINGS, "hi"]);
  assert.equal(claude[1][0], "--bg");
  const codex = startCommand("codex", "/r", "hi", { managed: true, model: "gpt-x" });
  assert.deepEqual(codex[1].slice(-5), ["-c", "agents.enabled=false", "-c", "features.multi_agent_v2=false", "hi"]);
  assert.deepEqual(codex[1].slice(0, 2), ["exec", "--json"]);
  assert.deepEqual(startCommand("opencode", "/r", "hi", { managed: true }), startCommand("opencode", "/r", "hi"));
  assert.ok(!startCommand("claude", "/r", "hi")[1].includes("--settings"));
});

test("startSession marks a managed child in its env and argv; an unmanaged one gets neither", async (t) => {
  const f = fixture(t);
  const managed = recorder();
  await startSession(f.cfg, { harness: "claude", prompt: "hi", env: f.env, run: managed.run, managed: true, waitMs: 1000, claudePermission: "auto" });
  assert.equal(managed.seen[0].env[MANAGED_ENV], "1");
  assert.ok(managed.seen[0].args.includes(CLAUDE_NO_SUBAGENT_SETTINGS));

  const opencode = recorder();
  await startSession(f.cfg, { harness: "opencode", prompt: "hi", env: f.env, run: opencode.run, managed: true, waitMs: 1000 });
  assert.equal(opencode.seen[0].env.OPENCODE_CONFIG_CONTENT, '{"permission":{"subagent":"deny"}}');

  const plain = recorder();
  await startSession(f.cfg, { harness: "claude", prompt: "hi", env: { ...f.env, [MANAGED_ENV]: "1" }, run: plain.run, waitMs: 1000, claudePermission: "auto" });
  assert.equal(plain.seen[0].env[MANAGED_ENV], undefined);
  assert.ok(!plain.seen[0].args.includes(CLAUDE_NO_SUBAGENT_SETTINGS));
});

test("teamStart starts a roster member managed", async (t) => {
  const f = fixture(t);
  const env = { ...f.env, AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex" };
  const cfg = loadConfig(env);
  const quiet = { write() {} };
  assert.equal(await runCli(["team", "create", "light", "codex"], { env, stdout: quiet, stderr: quiet, async readStdin() { return ""; } }), 0);
  let seen = null;
  const start = async (_cfg, opts) => { seen = opts; return { status: "started", session: "codex#0123456789abcdef", detail: "" }; };
  await teamStart(cfg, "light", "codex", "do it", env, { start });
  assert.equal(seen.managed, true);
});
