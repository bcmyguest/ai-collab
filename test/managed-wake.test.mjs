import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { controlSession, harnessCommand } from "../lib/sessions/control.ts";
import { recordSession } from "../lib/sessions/registry.ts";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { CLAUDE_NO_SUBAGENT_SETTINGS, CODEX_NO_SUBAGENT_ARGS, MANAGED_ENV } from "../lib/subagent-guard.ts";
import { tempDir } from "./helpers/tmp.mjs";

const sessionId = "00000000-abcd-1234-9876-0000000000aa";
const exited = { pid: 4_194_000, pidStart: "1" };
const host = { runner: { kind: "host" } };

test("a managed wake keeps native subagents off in argv and env; an unmanaged wake does not", async (t) => {
  // The wake env comes from process.env, so its start ticket lands under this temp state home.
  const state = tempDir(t, "ai-collab-wake-state-");
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => { if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved; rmSync(state, { recursive: true, force: true }); });
  const claude = harnessCommand("wake", "claude", sessionId, false, { managed: true });
  assert.deepEqual(claude[1].slice(-3, -1), ["--settings", CLAUDE_NO_SUBAGENT_SETTINGS]);
  const codex = harnessCommand("wake", "codex", sessionId, false, { managed: true });
  const resumeAt = codex[1].indexOf("resume");
  assert.deepEqual(codex[1].slice(resumeAt - CODEX_NO_SUBAGENT_ARGS.length, resumeAt), [...CODEX_NO_SUBAGENT_ARGS]);
  assert.ok(!harnessCommand("wake", "claude", sessionId, false, {})[1].includes("--settings"));

  for (const [harness, managed] of [["claude", true], ["codex", true], ["claude", false]]) {
    let seen = null;
    const execute = async (file, args, { env }) => { seen = { args, env }; return 0; };
    const peer = { sessionId, cwd: "/tmp", id: `${harness}#${sessionLabel(sessionId)}`, harness, ...exited, ...(managed ? { managed: true } : {}) };
    assert.equal((await controlSession("wake", peer, { ...host, execute })).status, "succeeded");
    assert.equal(seen.env[MANAGED_ENV], managed ? "1" : undefined);
  }
});

test("the registry keeps managed across later hook writes", async (t) => {
  const dir = tempDir(t, "managed-registry-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const label = sessionLabel(sessionId);
  const cfg = loadConfig({ AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude", AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_STATE_DIR: dir, HOME: dir }, { session: label });
  await recordSession(cfg, { id: sessionId, cwd: "/tmp", harness: "claude", event: "SessionStart", managed: true });
  await recordSession(cfg, { id: sessionId, cwd: "/tmp", harness: "claude", event: "Stop" });
  const entry = JSON.parse(readFileSync(path.join(dir, "demo", "registry", `claude#${label}.json`), "utf8"));
  assert.equal(entry.managed, true);
});
