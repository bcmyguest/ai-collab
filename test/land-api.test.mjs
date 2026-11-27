// POST /api/land merges a green PR and starts deploy; both need the same sign-in and same-origin checks as approvals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { LandRefused } from "../lib/land.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const origin = "https://ui.example.test";
const SHA = "c".repeat(40);
const PR = { number: 7, title: "Land", url: "https://github.com/o/r/pull/7", branch: "feat/land", headSha: SHA, additions: 1, deletions: 0, checks: "success" };
const auth = { user: (request) => (request.headers.has("x-test-login") ? { login: request.headers.get("x-test-login") } : null) };

function request(method, login, body, { sameOrigin = true } = {}) {
  return new Request(origin + "/api/land", {
    method,
    headers: { ...(login ? { "x-test-login": login } : {}), ...(sameOrigin ? { origin } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function setup(t, { merge } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  const merged = [];
  let deploys = 0;
  const land = {
    list: async () => [PR],
    merge: merge ?? (async (number, headSha) => { merged.push([number, headSha]); return { merged: true, number }; }),
    startDeploy: async () => { deploys += 1; },
    lastDeploy: async () => null,
  };
  const ui = createUi({ cfg, allowedOrigin: origin, env, auth, land });
  t.after(() => ui.close());
  return { ui, merged, deploys: () => deploys };
}

test("POST /api/land without sign-in is refused and merges nothing", async (t) => {
  const { ui, merged, deploys } = await setup(t);
  const response = await ui.handle(request("POST", null, { number: 7, headSha: SHA }), "land");
  assert.equal(response.status, 401);
  assert.deepEqual(merged, []);
  assert.equal(deploys(), 0);
});

test("POST /api/land from another origin is refused", async (t) => {
  const { ui, merged } = await setup(t);
  const response = await ui.handle(request("POST", "alice", { number: 7, headSha: SHA }, { sameOrigin: false }), "land");
  assert.equal(response.status, 403);
  assert.deepEqual(merged, []);
});

test("GET /api/land without sign-in is refused", async (t) => {
  const { ui } = await setup(t);
  const response = await ui.land(request("GET", null));
  assert.equal(response.status, 401);
});

test("a signed-in merge merges the PR at the reviewed head and starts deploy", async (t) => {
  const { ui, merged, deploys } = await setup(t);
  const response = await ui.handle(request("POST", "alice", { number: 7, headSha: SHA }), "land");
  assert.equal(response.status, 201);
  assert.deepEqual(merged, [[7, SHA]]);
  assert.equal(deploys(), 1);
  assert.match((await response.json()).detail, /#7/);
});

test("a refused merge answers 409 with the reason and starts no deploy", async (t) => {
  const { ui, deploys } = await setup(t, { merge: async () => { throw new LandRefused("#7 checks are failing"); } });
  const response = await ui.handle(request("POST", "alice", { number: 7, headSha: SHA }), "land");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "#7 checks are failing");
  assert.equal(deploys(), 0);
});

test("POST /api/land rejects a body without a PR number and head commit", async (t) => {
  const { ui, merged } = await setup(t);
  for (const body of [{ headSha: SHA }, { number: 7 }, { number: "7; rm", headSha: SHA }, { number: 7, headSha: "main" }]) {
    const response = await ui.handle(request("POST", "alice", body), "land");
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(merged, []);
});

test("GET /api/land lists the open PRs for a signed-in operator", async (t) => {
  const { ui } = await setup(t);
  const response = await ui.land(request("GET", "alice"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { prs: [PR], deploy: null });
});
