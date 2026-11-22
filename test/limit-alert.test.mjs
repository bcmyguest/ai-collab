import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { LIMIT_TOOL, WAIT_LABEL, alertLimit, limitLine, replacementOptions, resetClock, roleFallback } from "../lib/limit-alert.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const LISTED = { claude: ["sonnet", "opus"], codex: ["gpt-5"], cursor: ["auto"], opencode: ["anthropic/claude-sonnet-4-5"] };
const FIVE_HOUR = { window: "five_hour", windowName: "5-hour", resetsAt: new Date(2026, 10, 22, 18, 0).getTime(), verified: true, source: "test" };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  return { fake, env, cfg: { ...loadConfig(env), session: SESSION } };
}

const cards = (fake) => fake.state.publishes.flatMap((p) => { try { const m = JSON.parse(p.message); return m.kind === "approval" ? [m] : []; } catch { return []; } });

test("resetClock formats a local HH:MM and is empty without a time", () => {
  assert.equal(resetClock(new Date(2026, 10, 22, 18, 0).getTime()), "18:00");
  assert.equal(resetClock(null), "");
});

test("limitLine names the agent, the window and the reset", () => {
  assert.equal(limitLine({ harness: "claude", model: "claude-opus-5-5", windowName: "5-hour", resetsAt: new Date(2026, 10, 22, 18, 0).getTime() }),
    "Limit reached · claude:claude-opus-5-5 · 5-hour · resets 18:00");
  assert.equal(limitLine({ harness: "codex" }), "Limit reached · codex · reset time unknown");
});

test("replacementOptions puts a valid role fallback first and skips the current harness", () => {
  const out = replacementOptions({ harness: "claude", model: "opus", fallback: "codex:gpt-5", models: LISTED, available: ["claude", "codex", "cursor", "opencode"] });
  assert.deepEqual(out.map((o) => o.label), ["codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"]);
  assert.equal(out[0].description, "Role fallback");
});

test("replacementOptions ignores a malformed fallback and caps the list at four", () => {
  const many = { claude: ["a1"], codex: ["b1"], cursor: ["c1"], opencode: ["d1/e1"] };
  const out = replacementOptions({ harness: "claude", fallback: "nonsense", models: many, available: ["codex", "cursor", "opencode"] });
  assert.equal(out.length, 3);
  const capped = replacementOptions({ harness: "claude", fallback: "codex:x1", models: many, available: ["codex", "cursor", "opencode"] });
  assert.equal(capped.length, 4);
  assert.ok(capped.every((o) => o.label !== "claude:a1"));
});

test("alertLimit publishes one choice card and skips the same window", async (t) => {
  const { fake, cfg } = await setup(t);
  const deps = { listed: async () => LISTED, available: () => ["claude", "codex"] };
  const first = await alertLimit(cfg, { harness: "claude", limit: FIVE_HOUR, ...deps });
  assert.equal(first.status, "sent");
  const [card] = cards(fake);
  assert.equal(card.tool, LIMIT_TOOL);
  assert.equal(card.harness, "claude");
  assert.equal(card.summary, "Limit reached · claude · 5-hour · resets 18:00");
  assert.deepEqual(card.questions[0].options.map((o) => o.label), ["codex:gpt-5", WAIT_LABEL]);
  assert.ok(fake.state.publishes.some((p) => p.topic === ALL));

  assert.deepEqual(await alertLimit(cfg, { harness: "claude", limit: FIVE_HOUR, ...deps }), { status: "duplicate" });
  assert.equal(cards(fake).length, 1);

  const weekly = { ...FIVE_HOUR, window: "seven_day", windowName: "weekly", resetsAt: null };
  assert.equal((await alertLimit(cfg, { harness: "claude", limit: weekly, ...deps })).status, "sent");
  assert.equal(cards(fake).length, 2);
});

test("alertLimit publishes a second card after the known reset passes", async (t) => {
  const { fake, cfg } = await setup(t);
  const deps = { listed: async () => LISTED, available: () => ["codex"] };
  await alertLimit(cfg, { harness: "claude", limit: FIVE_HOUR, now: FIVE_HOUR.resetsAt - 60_000, ...deps });
  assert.equal((await alertLimit(cfg, { harness: "claude", limit: FIVE_HOUR, now: FIVE_HOUR.resetsAt + 1, ...deps })).status, "sent");
  assert.equal(cards(fake).length, 2);
});

test("a limit alert never spawns a harness CLI to list models", async (t) => {
  const { fake, env, cfg } = await setup(t);
  const bin = mkdtempSync(join(tmpdir(), "limit-bin-"));
  const marker = join(bin, "spawned.txt");
  // Fake executables that only record that they ran; no real CLI is started.
  for (const name of ["opencode", "cursor-agent"]) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`, { mode: 0o755 });
  await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: FIVE_HOUR, env: { ...env, PATH: bin } });
  assert.equal(existsSync(marker), false);
  assert.equal(cards(fake).length, 1);
});

test("a session in a pattern run puts its role's fallback first on the card", async (t) => {
  const { fake, cfg } = await setup(t);
  const runs = join(cfg.stateDir, cfg.project, "pattern-runs");
  mkdirSync(runs, { recursive: true });
  const run = { id: "run42a", definition: { roles: [{ id: "reviewer", harness: "claude", responsibility: "Review", fallback: "codex:gpt-5" }] }, sessions: { reviewer: `alice#${SESSION}` } };
  writeFileSync(join(runs, "run42a.json"), JSON.stringify(run));
  assert.equal(roleFallback(cfg, `alice#${SESSION}`), "codex:gpt-5");
  assert.equal(roleFallback(cfg, "alice#ffffffffffffffff"), undefined);
  const sessionCfg = { ...cfg, session: SESSION };
  await alertLimit(sessionCfg, { harness: "claude", limit: FIVE_HOUR, listed: async () => LISTED, available: () => ["cursor"] });
  const [card] = cards(fake);
  assert.deepEqual(card.questions[0].options.map((o) => o.label), ["codex:gpt-5", "cursor:auto", WAIT_LABEL]);
  assert.equal(card.questions[0].options[0].description, "Role fallback");
});
