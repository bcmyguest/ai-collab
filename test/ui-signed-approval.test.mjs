// The UI signs a signed-approval card's Allow only for a GitHub-signed-in operator; the agent then holds a one-time grant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { requestGrant } from "../lib/approvals.mjs";
import { takeGrant } from "../lib/grants.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const SESSION = "aabbccddeeff0011";
const INPUT = { command: "git apply /tmp/goldens.patch", description: "Apply the golden patch" };
const BASE = "http://127.0.0.1:8795";

async function card(fake) {
  for (let i = 0; i < 200; i++) {
    const found = fake.state.publishes.map((p) => { try { return parseWireEnvelope(p.message); } catch { return null; } }).find((m) => m?.kind === "approval");
    if (found) return found;
    await delay(10);
  }
  throw new Error("no approval published");
}

async function setup(t, user) {
  const fake = await startFakeNtfy();
  const cfg = { ...loadConfig(peerEnv(fake, { peer: "claude" })), session: SESSION };
  const auth = { user: () => user, route: async () => new Response(null, { status: 404 }), hosted: false };
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator" })), env: { ...process.env, AI_COLLAB_STATE_DIR: cfg.stateDir }, auth: user === undefined ? null : auth });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); fake.close(); });
  const pending = requestGrant(cfg, { tool: "Bash", input: INPUT, reason: "Apply the approved goldens", seconds: 10 });
  const asked = await card(fake);
  const stream = sse(ui.events(new Request(`${BASE}/api/events`, { signal: ctrl.signal })));
  for (;;) {
    const { done, value } = await stream.next();
    if (done) throw new Error("stream ended");
    if (value.event === "state" && value.data.messages.some(m => m.kind === "Approval" && m.approval.id === asked.id)) break;
  }
  const post = (decision) => ui.handle(new Request(`${BASE}/api/approve`, {
    method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ id: asked.id, decision }),
  }), "approve");
  return { cfg, asked, pending, post };
}

test("a signed-in Allow sends a grant the agent stores for the exact call", async (t) => {
  const { cfg, asked, pending, post } = await setup(t, { login: "octocat", name: "" });
  const res = await post("allow");
  assert.equal(res.status, 201);
  const result = await pending;
  assert.equal(result.status, "approved");
  assert.equal(result.by, "octocat");
  assert.equal(takeGrant(cfg.stateDir, { session: SESSION, tool: "Bash", input: INPUT })?.id, asked.id);
});

test("without GitHub sign-in Allow is refused and Deny still works", async (t) => {
  const { pending, post } = await setup(t, undefined);
  assert.equal((await post("allow")).status, 403);
  assert.equal((await post("deny")).status, 201);
  assert.equal((await pending).status, "denied");
});
