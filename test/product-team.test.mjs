import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { CURSOR_FALLBACK } from "../lib/limit-alert.ts";
import { checkTeamText } from "../lib/patterns.mjs";
import { teamStart } from "../lib/teams.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const FALLBACK = `${CURSOR_FALLBACK.harness}:${CURSOR_FALLBACK.model}`;
const GROK = "cursor:grok-4.7-high";
const MODELS = { cursor: ["grok-4.7-high", CURSOR_FALLBACK.model] };

async function fixture(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-product-team-");
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "cursor" }]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "cursor", AI_COLLAB_PROJECT: "demo" }), HOME: home };
  return { env, cfg: loadConfig(env) };
}

test("the product team validates and each role names one limit-chain fallback", async (t) => {
  const text = readFileSync(new URL("../lib/team-templates/product/team.dot", import.meta.url), "utf8");
  const { env, cfg } = await fixture(t);
  const checked = checkTeamText(cfg, "product", text);
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(checked.pattern.roles.map((role) => role.id), ["pm", "engineer", "review", "ceo"]);
  assert.ok(checked.pattern.roles.every((role) => role.fallback === FALLBACK));
  for (const id of ["pm", "ceo"]) {
    const role = checked.pattern.roles.find((item) => item.id === id);
    assert.equal(`${role.harness}:${role.model}`, GROK);
  }
  assert.ok(checked.pattern.roles.every((role) => `${role.harness}:${role.model}` !== role.fallback));
  assert.equal(checked.pattern.handoffs.find((item) => item.on === "reported").to, "pm");
  assert.equal(checked.pattern.handoffs.find((item) => item.on === "several tasks").required, false);
  assert.equal(checked.pattern.handoffs.find((item) => item.on === "task closed").to, "done");

  const calls = [];
  const started = await teamStart(cfg, "product", "pm", "Check this task against the product vision.", env, {
    start: async (_cfg, options) => {
      calls.push(options);
      return { status: "started", session: `${options.harness}#0123456789abcdef`, detail: "ok" };
    },
    models: MODELS,
  });
  assert.equal(started.status, "running");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "grok-4.7-high");
  assert.match(calls[0].prompt, /role "pm"/);
  assert.match(calls[0].prompt, /clean the backlog/);
  assert.match(calls[0].prompt, /answer operator and agent questions/);
  assert.match(checked.pattern.roles.find((role) => role.id === "review").responsibility, /screen-state/);
  assert.match(calls[0].prompt, new RegExp(`This session continues as ${FALLBACK.replace(/[.]/g, "\\.")}`));
});
