// Shared setup for runner tests: a throwaway HOME with one project on the fake ntfy, and a runner over a durable log.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../../lib/config.mjs";
import { openDurable } from "../../runner/durable.mjs";
import { createRunner } from "../../runner/runner.mjs";
import { fileEnd, tempDir } from "./tmp.mjs";

export function setup(fake) {
  const home = tempDir(fileEnd, "ai-collab-runner-ctx-");
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  assert.equal(cfg.enabled, true, cfg.reason);
  return { home, root, env, cfg, db: path.join(home, "state", "runner.db") };
}

// A runner over the adapters, with the delivery deps overridden by `delivery`; pump only when called.
export function makeRunner(ctx, adapters, { watch = false, delivery = {} } = {}) {
  const durable = openDurable(ctx.db);
  const runner = createRunner({
    projects: [ctx.cfg], adapters: new Map(adapters.map((a) => [a.harness, a])), durable, env: ctx.env, startGapMs: 0, watch, pumpMs: 0, delivery,
  });
  return { durable, runner };
}

export async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The start tick of a process as the registry stores it (/proc/<pid>/stat field 22).
export function procStart(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
}
