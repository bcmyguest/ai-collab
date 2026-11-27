// Limit reports with no window, for one harness, share one open card: a burst of limited builders yields one card, not one per session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { alertLimit, readCard } from "../lib/limit-alert.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const SESSIONS = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];
const LISTED = { claude: ["sonnet"], codex: ["gpt-5"] };
const RESET = new Date(2026, 10, 22, 18, 0).getTime();
const NOW = RESET - 2 * 3600_000;
const UNTYPED = { window: null, windowName: null, resetsAt: null, wording: true, verified: true, source: "test" };
const TYPED = { window: "five_hour", windowName: "5-hour", resetsAt: RESET, wording: true, verified: true, source: "test" };
const deps = { now: NOW, listed: async () => LISTED, available: () => ["claude", "codex"] };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  return { fake, cfg: loadConfig(peerEnv(fake, { peer: "codex" })) };
}

const decoded = (fake, kind) => fake.state.publishes.flatMap((p) => { try { const m = parseWireEnvelope(p.message); return m.kind === kind ? [m] : []; } catch { return []; } });
const indexOf = (cfg) => JSON.parse(readFileSync(join(cfg.stateDir, cfg.project, "limit-windows.json"), "utf8"));
// Cards still offered: published and not closed by an approval-end.
const openCards = (fake) => {
  const ended = new Set(decoded(fake, "approval-end").map((m) => m.id));
  return decoded(fake, "approval").filter((m) => !ended.has(m.id));
};

test("three sessions of one harness with an unknown window share one open card that lists them all", async (t) => {
  const { fake, cfg } = await setup(t);
  const results = [];
  for (const session of SESSIONS) results.push(await alertLimit({ ...cfg, session }, { harness: "codex", limit: UNTYPED, ...deps }));
  assert.deepEqual(results.map((r) => [r.status, r.sessions]), [["sent", 1], ["sent", 2], ["sent", 3]]);
  const open = openCards(fake);
  assert.equal(open.length, 1, "one card stays offered");
  assert.equal(open[0].id, results[2].id);
  assert.equal(open[0].summary, `Limit reached · codex · reset time unknown\nSessions: ${SESSIONS.map((s) => `codex#${s}`).join(", ")}`);
  assert.deepEqual(decoded(fake, "approval-end").map((m) => [m.id, m.reason]), [[results[0].id, "cancelled"], [results[1].id, "cancelled"]]);
  assert.deepEqual(Object.keys(indexOf(cfg)), ["codex|unknown"]);
  assert.equal(readCard(cfg, results[2].id).sessions.length, 3);
});

test("a repeated unknown report from a session already on the card is a duplicate", async (t) => {
  const { fake, cfg } = await setup(t);
  await alertLimit({ ...cfg, session: SESSIONS[0] }, { harness: "codex", limit: UNTYPED, ...deps });
  await alertLimit({ ...cfg, session: SESSIONS[1] }, { harness: "codex", limit: UNTYPED, ...deps });
  assert.deepEqual(await alertLimit({ ...cfg, session: SESSIONS[0] }, { harness: "codex", limit: UNTYPED, ...deps }), { status: "duplicate" });
  assert.equal(decoded(fake, "approval").length, 2);
});

test("unknown windows of different harnesses keep separate cards", async (t) => {
  const { fake, cfg } = await setup(t);
  await alertLimit({ ...cfg, session: SESSIONS[0] }, { harness: "codex", limit: UNTYPED, ...deps });
  const claude = await alertLimit({ ...cfg, session: SESSIONS[1] }, { harness: "claude", limit: UNTYPED, ...deps });
  assert.equal(claude.sessions, 1);
  assert.equal(openCards(fake).length, 2);
  assert.deepEqual(Object.keys(indexOf(cfg)).sort(), ["claude|unknown", "codex|unknown"]);
});

test("a typed report upgrades the shared untyped card, keeping every session on it", async (t) => {
  const { fake, cfg } = await setup(t);
  const first = await alertLimit({ ...cfg, session: SESSIONS[0] }, { harness: "codex", limit: UNTYPED, ...deps });
  const shared = await alertLimit({ ...cfg, session: SESSIONS[1] }, { harness: "codex", limit: UNTYPED, ...deps });
  // The first session's own untyped card was superseded by the shared one; its typed report still upgrades that shared card.
  const typed = await alertLimit({ ...cfg, session: SESSIONS[0] }, { harness: "codex", limit: TYPED, ...deps });
  assert.equal(typed.status, "sent");
  assert.equal(typed.sessions, 2);
  assert.match(typed.line, /5-hour · resets 18:00/);
  const open = openCards(fake);
  assert.deepEqual(open.map((m) => m.id), [typed.id]);
  assert.deepEqual(decoded(fake, "approval-end").map((m) => m.id), [first.id, shared.id]);
  // A later unknown report from a third session joins the upgraded card instead of opening a new one.
  const late = await alertLimit({ ...cfg, session: SESSIONS[2] }, { harness: "codex", limit: UNTYPED, ...deps });
  assert.equal(late.sessions, 3);
  assert.match(late.line, /5-hour · resets 18:00/);
  assert.equal(openCards(fake).length, 1);
});
