// request_approval: only a correctly signed Allow for this card and session stores a grant; anything else keeps waiting.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { requestGrant } from "../lib/approvals.mjs";
import { inputHash, loadSigner, signGrant, takeGrant } from "../lib/grants.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const INPUT = { file_path: "/repo/test/golden/x.json", content: "{}\n" };

async function card(fake) {
  for (let i = 0; i < 200; i++) {
    const found = fake.state.publishes.map((p) => { try { return parseWireEnvelope(p.message); } catch { return null; } }).find((m) => m?.kind === "approval");
    if (found) return found;
    await delay(10);
  }
  throw new Error("no approval published");
}

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = { ...loadConfig(peerEnv(fake, { peer: "claude" })), session: SESSION };
  return { fake, cfg, key: loadSigner(cfg.stateDir) };
}

test("a signed allow stores a grant that covers the exact call", async (t) => {
  const { fake, cfg, key } = await setup(t);
  const pending = requestGrant(cfg, { tool: "Write", input: INPUT, reason: "Regenerate the golden", seconds: 10 });
  const asked = await card(fake);
  assert.equal(asked.grant.inputHash, inputHash("Write", INPUT));
  assert.match(asked.summary, /^Regenerate the golden: /);

  // A plain allow from the ntfy app, a forged grant and another card's grant are ignored.
  fake.inject(ALL, `reply ${asked.id} allow`);
  const forged = signGrant(generateKeyPairSync("ed25519").privateKey, { id: asked.id, session: SESSION, tool: "Write", inputHash: asked.grant.inputHash, by: "octocat" });
  fake.inject(ALL, `reply ${asked.id} allow ${forged}`);
  fake.inject(ALL, `reply ${asked.id} allow ${signGrant(key, { id: "000000000000", session: SESSION, tool: "Write", inputHash: asked.grant.inputHash, by: "octocat" })}`);
  await delay(100);
  fake.inject(ALL, `reply ${asked.id} allow ${signGrant(key, { id: asked.id, session: SESSION, tool: "Write", inputHash: asked.grant.inputHash, by: "octocat" })}`);

  const result = await pending;
  assert.equal(result.status, "approved");
  assert.equal(result.by, "octocat");
  assert.equal(takeGrant(cfg.stateDir, { session: SESSION, tool: "Write", input: INPUT })?.id, asked.id);
});

test("a deny stores nothing", async (t) => {
  const { fake, cfg } = await setup(t);
  const pending = requestGrant(cfg, { tool: "Write", input: INPUT, seconds: 10 });
  fake.inject(ALL, `reply ${(await card(fake)).id} deny`);
  assert.equal((await pending).status, "denied");
  assert.equal(takeGrant(cfg.stateDir, { session: SESSION, tool: "Write", input: INPUT }), null);
});
