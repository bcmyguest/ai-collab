import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { alertLimit, CURSOR_FALLBACK } from "../lib/limit-alert.ts";
import { checkTeamText } from "../lib/patterns.mjs";
import { teamStart } from "../lib/teams.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const LIMIT = { window: "five_hour", windowName: "5-hour", resetsAt: null, wording: true, verified: true, source: "test" };
const FALLBACK = `${CURSOR_FALLBACK.harness}:${CURSOR_FALLBACK.model}`;
const MODELS = { cursor: ["grok-4.7-high", CURSOR_FALLBACK.model] };

function approvals(messages) {
  return messages.flatMap((message) => {
    try {
      const parsed = parseWireEnvelope(message);
      return parsed.kind === "approval" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function fixture(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-review-team-"));
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "cursor" }]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "cursor", AI_COLLAB_PROJECT: "demo" }), HOME: home };
  return { env, cfg: loadConfig(env) };
}

test("the review team validates and a limited role names its fallback", async (t) => {
  const text = readFileSync(new URL("../lib/team-templates/review/team.dot", import.meta.url), "utf8");
  const { env, cfg } = await fixture(t);
  const checked = checkTeamText(cfg, "review", text);
  assert.equal(checked.ok, true, checked.error);
  assert.ok(checked.pattern.roles.some((role) => role.id === "reviewer"));
  assert.ok(checked.pattern.roles.every((role) => role.fallback === FALLBACK));
  const reviewer = checked.pattern.roles.find((role) => role.id === "reviewer");
  assert.notEqual(`${reviewer.harness}:${reviewer.model}`, FALLBACK);

  const calls = [];
  const start = async (_cfg, options) => {
    calls.push(options);
    return { status: "started", session: `${options.harness}#0123456789abcdef`, detail: "ok" };
  };
  const started = await teamStart(cfg, "review", "reviewer", "Review the diff for task ready-1", env, { start, models: MODELS });
  assert.equal(started.status, "running");
  assert.match(calls[0].prompt, /screen-state\.mjs/);
  assert.match(calls[0].prompt, new RegExp(`This session continues as ${FALLBACK.replace(/[.]/g, "\\.")}`));
  assert.equal(calls[0].model, reviewer.model);

  const [peer, label] = started.session.split("#");
  const continued = [];
  const sent = [];
  const result = await alertLimit({ ...cfg, peer, session: label }, {
    harness: reviewer.harness,
    limit: LIMIT,
    auto: true,
    start: async (_cfg, options) => {
      continued.push(options);
      return { status: "started", session: `${FALLBACK.split(":")[0]}#fedcba9876543210`, detail: "ok" };
    },
    send: async (...args) => { sent.push(args[2]); },
    listed: async () => ({}),
    available: () => ["cursor", "opencode"],
  });
  assert.equal(result.status, "started");
  assert.equal(continued[0].harness, CURSOR_FALLBACK.harness);
  assert.equal(continued[0].model, CURSOR_FALLBACK.model);
  assert.match(sent.join("\n"), new RegExp(`continued as ${FALLBACK.replace(/[.]/g, "\\.")}`));
  assert.equal(approvals(sent).length, 0);
});
