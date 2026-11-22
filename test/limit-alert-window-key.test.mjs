import { parseWireEnvelope } from "../lib/agui.mjs";
// One limit card per harness and window: a known-reset report and an unknown-reset report for the same harness and window, from
// different sessions, share one card and the known reset upgrades it in place instead of opening a second card.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { alertLimit, readCard } from "../lib/limit-alert.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const SESSION = "aabbccddeeff0011";
const OTHER = "1111222233334444";
const LISTED = { claude: ["sonnet"], codex: ["gpt-5"] };
const RESET = new Date(2026, 10, 22, 18, 0).getTime();
const UNKNOWN = { window: "five_hour", windowName: "5-hour", resetsAt: null, wording: true, verified: true, source: "test" };
const KNOWN = { ...UNKNOWN, resetsAt: RESET };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  return { fake, env, cfg: loadConfig(env) };
}

const cards = (fake) => fake.state.publishes.flatMap((p) => { try { const m = parseWireEnvelope(p.message); return m.kind === "approval" ? [m] : []; } catch { return []; } });
const ends = (fake) => fake.state.publishes.flatMap((p) => { try { const m = parseWireEnvelope(p.message); return m.kind === "approval-end" ? [m] : []; } catch { return []; } });
const indexOf = (cfg) => JSON.parse(readFileSync(join(cfg.stateDir, cfg.project, "limit-windows.json"), "utf8"));
const deps = { listed: async () => LISTED, available: () => ["codex"] };

test("an unknown-reset report and a known-reset report for one harness and window share one card", async (t) => {
  const { fake, cfg } = await setup(t);
  const now = RESET - 2 * 60 * 60_000;
  const first = await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: UNKNOWN, now, ...deps });
  assert.equal(first.status, "sent");
  assert.equal(cards(fake)[0].summary, "Limit reached · claude · 5-hour · reset time unknown");
  // The index holds one entry for claude's 5-hour window, not one per reset value.
  assert.deepEqual(Object.keys(indexOf(cfg)), ["claude|five_hour"]);

  const second = await alertLimit({ ...cfg, session: OTHER }, { harness: "claude", limit: KNOWN, now, ...deps });
  assert.equal(second.status, "sent");
  assert.equal(second.sessions, 2, "the second session joins the open card");
  // Two approvals published, but only one card stays offered: the first is closed with "cancelled".
  const published = cards(fake);
  assert.equal(published.length, 2);
  assert.equal(published[1].summary, "Limit reached · claude · 5-hour · resets 18:00\nSessions: alice#aabbccddeeff0011, alice#1111222233334444");
  assert.deepEqual(ends(fake).map((m) => [m.id, m.reason]), [[first.id, "cancelled"]]);
  assert.deepEqual(Object.keys(indexOf(cfg)), ["claude|five_hour"], "still one index entry");
  // The card behind the pick carries the known reset and expires at it.
  const stored = readCard(cfg, second.id);
  assert.equal(stored.resetsAt, RESET);
  assert.equal(stored.expiresAt, RESET);
  assert.equal(stored.sessions.length, 2);
});

test("a known-reset card first and an unknown-reset session after keep the known reset", async (t) => {
  const { fake, cfg } = await setup(t);
  const now = RESET - 2 * 60 * 60_000;
  await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: KNOWN, now, ...deps });
  const later = await alertLimit({ ...cfg, session: OTHER }, { harness: "claude", limit: UNKNOWN, now, ...deps });
  assert.equal(later.status, "sent");
  assert.match(later.line, /resets 18:00/, "an unknown reset does not erase the known one");
  assert.equal(later.sessions, 2);
  assert.deepEqual(Object.keys(indexOf(cfg)), ["claude|five_hour"]);
  assert.equal(readCard(cfg, later.id).resetsAt, RESET);
});

test("different windows and harnesses keep separate index entries", async (t) => {
  const { cfg } = await setup(t);
  const now = RESET - 2 * 60 * 60_000;
  await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: KNOWN, now, ...deps });
  await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: { ...UNKNOWN, window: "seven_day", windowName: "weekly" }, now, ...deps });
  assert.deepEqual(Object.keys(indexOf(cfg)).sort(), ["claude|five_hour", "claude|seven_day"]);
});

test("a legacy resetsAt-keyed index entry is still joined, then folded into the harness-and-window key", async (t) => {
  const { fake, cfg } = await setup(t);
  const now = RESET - 2 * 60 * 60_000;
  const first = await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: UNKNOWN, now, ...deps });
  // Simulate state written by the previous release, which keyed the entry by harness, window and resetsAt.
  writeFileSync(join(cfg.stateDir, cfg.project, "limit-windows.json"), JSON.stringify({ [`claude|five_hour|${RESET}`]: { card: first.id, expiresAt: now + 5 * 3600_000 } }));
  const second = await alertLimit({ ...cfg, session: OTHER }, { harness: "claude", limit: KNOWN, now, ...deps });
  assert.equal(second.status, "sent");
  assert.equal(second.sessions, 2, "the open card is found under the legacy key");
  assert.deepEqual(Object.keys(indexOf(cfg)), ["claude|five_hour"], "the legacy key is replaced, not duplicated");
  assert.equal(cards(fake).length, 2);
  assert.equal(readCard(cfg, second.id).resetsAt, RESET);
});

test("the same session reported twice for one window is a duplicate and writes no second card", async (t) => {
  const { cfg } = await setup(t);
  const now = RESET - 2 * 60 * 60_000;
  await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: KNOWN, now, ...deps });
  assert.deepEqual(await alertLimit({ ...cfg, session: SESSION }, { harness: "claude", limit: KNOWN, now, ...deps }), { status: "duplicate" });
  assert.equal(readdirSync(join(cfg.stateDir, cfg.project, "limit-cards")).length, 1);
});
