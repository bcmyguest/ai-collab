import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config.ts";
import { claimInbox } from "../lib/inbox.mjs";
import { formatInbox } from "../lib/format.ts";
import { SESSION_COOKIE, STATE_COOKIE, createAuth, signSession, verifySession } from "../web/server/auth.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const ORIGIN = "https://ai-collab-ui.example.test";
const SECRET = Buffer.alloc(32, 7);

// A config dir with github.json and a client secret file, plus an empty state dir.
function setup(users = ["Octocat"]) {
  const dir = tempDir({ after }, "ai-collab-auth-");
  const secretFile = path.join(dir, "client-secret");
  writeFileSync(secretFile, "shh-client-secret\n");
  writeFileSync(path.join(dir, "github.json"), JSON.stringify({ clientId: "Iv1.test", clientSecretFile: secretFile, users }));
  return { dir, stateDir: tempDir({ after }, "ai-collab-auth-state-") };
}

// Stands in for GitHub: records each call and answers the token and user endpoints.
function fakeGithub(login = "octocat") {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_test", token_type: "bearer" });
    if (String(url) === "https://api.github.com/user") return Response.json({ login, name: "The Octocat" });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch };
}

const cookiesOf = response => response.headers.getSetCookie();
const valueOf = (cookies, name) => cookies.find(item => item.startsWith(name + "="))?.split(";")[0].slice(name.length + 1);

async function signIn(auth) {
  const login = await auth.route(new Request(ORIGIN + "/api/auth/login"), "login");
  const state = valueOf(cookiesOf(login), STATE_COOKIE);
  const callback = await auth.route(new Request(`${ORIGIN}/api/auth/callback?code=abc&state=${state}`, {
    headers: { cookie: `${STATE_COOKIE}=${state}` },
  }), "callback");
  return { login, callback, session: valueOf(cookiesOf(callback), SESSION_COOKIE) };
}

test("session cookies verify, and reject tampering, another key and expiry", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  const exp = now / 1000 + 60;
  const value = signSession(SECRET, { login: "octocat", name: "The Octocat", exp });
  assert.deepEqual(verifySession(SECRET, value, now), { login: "octocat", name: "The Octocat", exp });
  const [data, mac] = value.split(".");
  const forged = Buffer.from(JSON.stringify({ login: "mallory", name: "", exp })).toString("base64url");
  assert.equal(verifySession(SECRET, forged + "." + mac, now), null);
  assert.equal(verifySession(SECRET, data + "." + mac.slice(0, -2) + "AA", now), null);
  assert.equal(verifySession(Buffer.alloc(32, 8), value, now), null);
  assert.equal(verifySession(SECRET, value, (exp + 1) * 1000), null);
  assert.equal(verifySession(SECRET, "", now), null);
  assert.equal(verifySession(SECRET, data + "." + mac + ".x", now), null);
  assert.equal(verifySession(SECRET, signSession(SECRET, { login: "-bad-", exp }), now), null);
});

test("sign-in is off without github.json and needs the UI origin with it", (t) => {
  const dir = tempDir(t, "ai-collab-auth-");
  assert.equal(createAuth({ dir, stateDir: dir, origin: ORIGIN }), null);
  const { dir: configured, stateDir } = setup();
  assert.throws(() => createAuth({ dir: configured, stateDir, origin: "" }), /AI_COLLAB_UI_ORIGIN/);
});

test("login redirects to GitHub with a state cookie; callback signs in an allowlisted user and drops the token", async () => {
  const { dir, stateDir } = setup();
  const github = fakeGithub("octocat");
  const auth = createAuth({ dir, stateDir, origin: ORIGIN, fetch: github.fetch });
  const secretFile = path.join(stateDir, "auth", "secret");
  assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(secretFile).length, 32);

  const { login, callback, session } = await signIn(auth);
  assert.equal(login.status, 302);
  const to = new URL(login.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), "Iv1.test");
  assert.equal(to.searchParams.get("redirect_uri"), ORIGIN + "/api/auth/callback");
  assert.equal(to.searchParams.get("scope"), "");
  assert.match(to.searchParams.get("state"), /^[a-f0-9]{32}$/);
  assert.match(cookiesOf(login)[0], /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  const set = cookiesOf(callback).find(item => item.startsWith(SESSION_COOKIE + "="));
  assert.match(set, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.doesNotMatch(set, /gho_test/);

  const [token, user] = github.calls;
  assert.equal(token.init.method, "POST");
  assert.equal(token.init.headers.accept, "application/json");
  assert.equal(token.init.headers["user-agent"], "ai-collab");
  assert.equal(token.init.body.get("client_secret"), "shh-client-secret");
  assert.equal(token.init.body.get("redirect_uri"), ORIGIN + "/api/auth/callback");
  assert.equal(user.init.headers.authorization, "Bearer gho_test");

  const signed = new Request(ORIGIN + "/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  assert.deepEqual(auth.user(signed), { login: "octocat", name: "The Octocat" });
  assert.deepEqual(await (await auth.route(signed, "me")).json(), { enabled: true, user: { login: "octocat", name: "The Octocat" } });
  // A second instance reuses the stored secret, so sessions survive a restart.
  assert.deepEqual(createAuth({ dir, stateDir, origin: ORIGIN, fetch: github.fetch }).user(signed), { login: "octocat", name: "The Octocat" });

  const logout = await auth.route(new Request(ORIGIN + "/api/auth/logout", { method: "POST", headers: { origin: ORIGIN } }), "logout");
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie"), new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0$`));
  assert.equal((await auth.route(new Request(ORIGIN + "/api/auth/logout", { method: "POST", headers: { origin: "https://evil.test" } }), "logout")).status, 403);
});

test("callback rejects a state mismatch without calling GitHub, and users outside the allowlist", async () => {
  const { dir, stateDir } = setup();
  const github = fakeGithub("mallory");
  const auth = createAuth({ dir, stateDir, origin: ORIGIN, fetch: github.fetch });
  for (const cookie of [`${STATE_COOKIE}=aaaa`, ""]) {
    const response = await auth.route(new Request(`${ORIGIN}/api/auth/callback?code=abc&state=bbbb`, { headers: { cookie } }), "callback");
    assert.equal(response.status, 400);
  }
  assert.equal(github.calls.length, 0);

  const { callback, session } = await signIn(auth);
  assert.equal(callback.status, 403);
  assert.equal(session, undefined);
  assert.match(await callback.text(), /mallory may not use/);
});

test("with sign-in on, /api routes answer 401 until signed in, and UI sends carry the GitHub login", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { dir, stateDir } = setup(["octocat", "hubot"]);
  const auth = createAuth({ dir, stateDir, origin: ORIGIN, fetch: fakeGithub().fetch });
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const modes = [];
  const ui = createUi({ cfg, allowedOrigin: ORIGIN, auth, setMode: async (cfgs, mode, by) => { modes.push([mode, by]); } });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const cookieFor = login => `${SESSION_COOKIE}=${signSession(readFileSync(path.join(stateDir, "auth", "secret")), { login, name: "", exp: Math.floor(Date.now() / 1000) + 60 })}`;
  const post = (action, body, cookie = "") => ui.handle(new Request(`${ORIGIN}/api/${action}`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }), action);

  assert.equal((await post("messages", { target: "all", body: "anonymous" })).status, 401);
  assert.equal(ui.events(new Request(`${ORIGIN}/api/events`)).status, 401);
  assert.equal((await ui.push(new Request(`${ORIGIN}/api/push/key`), "key")).status, 401);
  assert.equal((await ui.file("abc.png", new Request(`${ORIGIN}/api/file/abc.png`))).status, 401);
  assert.equal((await post("messages", { target: "all", body: "removed user" }, cookieFor("mallory"))).status, 401);
  assert.deepEqual(await (await ui.auth(new Request(`${ORIGIN}/api/auth/me`), "me")).json(), { enabled: true, user: null });

  assert.equal((await post("send", { target: `bob#${bob.session}`, body: "from octocat" }, cookieFor("octocat"))).status, 201);
  assert.equal((await post("send", { target: "all", body: "@bob from hubot" }, cookieFor("hubot"))).status, 201);
  assert.equal((await post("reply", { question: "123456789abc", body: "yes" }, cookieFor("hubot"))).status, 201);
  assert.equal((await post("afk", { mode: "on" }, cookieFor("octocat"))).status, 201);
  assert.deepEqual(modes, [["on", "octocat"]]);

  const got = await claimInbox(bob);
  assert.deepEqual(got.map(m => [m.body, m.by]), [["from octocat", "octocat"], ["@bob from hubot", "hubot"]]);
  assert.match(formatInbox(got), /from=operator \(octocat\) to=bob#0000000000000001/);

  const stream = ui.events(new Request(`${ORIGIN}/api/events`, { signal: ctrl.signal, headers: { cookie: cookieFor("octocat") } }));
  assert.equal(stream.status, 200);
  const state = await firstUpdate(stream, "state");
  const sent = state.messages.find(m => m.body === "@bob from hubot");
  assert.equal(sent.from, "operator");
  assert.equal(sent.by, "hubot");
  const reply = state.messages.find(m => m.kind === "Reply");
  assert.equal(reply.by, "hubot");
});

test("without sign-in, sends carry no login and the me route says sign-in is off", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = loadConfig(peerEnv(fake, { peer: "bob" }));
  const ui = createUi({ cfg });
  t.after(() => ui.close());
  assert.deepEqual(await (await ui.auth(new Request("http://127.0.0.1:8795/api/auth/me"), "me")).json(), { enabled: false, user: null });
  assert.equal((await ui.auth(new Request("http://127.0.0.1:8795/api/auth/login"), "login")).status, 404);
  const response = await ui.handle(new Request("http://127.0.0.1:8795/api/send", {
    method: "POST", headers: { Origin: "http://127.0.0.1:8795", "Content-Type": "application/json" }, body: JSON.stringify({ target: "all", body: "plain" }),
  }), "send");
  assert.equal(response.status, 201);
  const [message] = await claimInbox(bob);
  assert.equal(message.by, undefined);
  assert.match(formatInbox([message]), /from=operator to=all/);
});
