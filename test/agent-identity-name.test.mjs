import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import os from "node:os";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { agentDirectory, recordSession, setIdentity } from "../lib/sessions.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

test("a set_identity name survives a later harness title and reaches list_agents as identityName", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const id = "named-agents-session";
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", HOME: os.tmpdir(), AI_COLLAB_SESSION: sessionLabel(id) }));
  await recordSession(cfg, { id, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self() });
  assert.deepEqual(await setIdentity(cfg, { name: "PM", activity: "watching builders" }), { name: "PM", activity: "watching builders" });
  // A later hook reports its own title; the identity name stays, and identityName marks it as the agent's name.
  await recordSession(cfg, { id, cwd: "/tmp", harness: "claude", event: "UserPromptSubmit", proc: self(), name: "Fix the sidebar" });
  const [entry] = agentDirectory(cfg, { all: true });
  assert.deepEqual([entry.address, entry.name, entry.identityName], [`alice#${sessionLabel(id)}`, "PM", "PM"]);
});

test("an agent with no set_identity name has no identityName", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const id = "plain-session";
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: sessionLabel(id) }));
  await recordSession(cfg, { id, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self(), name: "Some title" });
  const [entry] = agentDirectory(cfg, { all: true });
  assert.equal(entry.name, "Some title");
  assert.equal(entry.identityName, undefined);
});
