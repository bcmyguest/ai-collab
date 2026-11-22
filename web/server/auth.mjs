/**
 * GitHub sign-in for the operator UI (OAuth app web flow). Off without ${configDir}/github.json.
 * The session cookie is base64url(JSON {login, name, exp}) + "." + HMAC-SHA256 under ${stateDir}/auth/secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isGithubLogin } from "../../lib/config.mjs";

export const SESSION_COOKIE = "__Host-ai-collab-session";
export const STATE_COOKIE = "__Host-ai-collab-state";
export const SESSION_TTL_S = 30 * 24 * 3600;
const STATE_TTL_S = 600;
const SECRET_BYTES = 32;
const NAME_MAX = 100;
const GITHUB_TIMEOUT_MS = 10_000;
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_AGENT = "ai-collab";
const STEPS = ["login", "callback", "logout", "me"];

const sign = (secret, data) => createHmac("sha256", secret).update(data).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A signed session cookie value for {login, name}, valid until exp (seconds). */
export function signSession(secret, { login, name = "", exp }) {
  const data = Buffer.from(JSON.stringify({ login, name, exp })).toString("base64url");
  return data + "." + sign(secret, data);
}

/** The session {login, name, exp} in a cookie value, or null when unsigned, tampered, malformed or expired. */
export function verifySession(secret, value, now = Date.now()) {
  const [data, mac, ...extra] = String(value || "").split(".");
  if (!data || !mac || extra.length || !safeEqual(mac, sign(secret, data))) return null;
  let session;
  try { session = JSON.parse(Buffer.from(data, "base64url").toString()); } catch { return null; }
  if (!isGithubLogin(session?.login) || !Number.isSafeInteger(session.exp) || session.exp * 1000 <= now) return null;
  return { login: session.login, name: typeof session.name === "string" ? session.name : "", exp: session.exp };
}

/** The value of one cookie in a Cookie header, or "". */
export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// The 32-byte HMAC key, created once with mode 0600; a concurrent creator's key wins.
function loadSecret(stateDir) {
  const dir = join(stateDir, "auth");
  const file = join(dir, "secret");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(file, randomBytes(SECRET_BYTES), { mode: 0o600, flag: "wx" }); } catch (err) { if (err.code !== "EEXIST") throw err; }
  const secret = readFileSync(file);
  if (secret.length !== SECRET_BYTES) throw new Error(`${file} must hold ${SECRET_BYTES} bytes`);
  return secret;
}

/** The github.json settings, or null when the file is missing; throws when it is invalid. */
export function loadGithubConfig(dir) {
  let raw;
  try { raw = readFileSync(join(dir, "github.json"), "utf8"); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  const value = JSON.parse(raw);
  if (typeof value?.clientId !== "string" || !value.clientId || typeof value.clientSecretFile !== "string" || !isAbsolute(value.clientSecretFile) ||
      (value.hosted !== undefined && typeof value.hosted !== "boolean") || !Array.isArray(value.users) || !value.users.length || !value.users.every(isGithubLogin)) {
    throw new Error("github.json needs clientId, an absolute clientSecretFile and a users list of GitHub logins");
  }
  return { hosted: value.hosted === true, clientId: value.clientId, clientSecretFile: value.clientSecretFile, users: value.users.map(user => user.toLowerCase()) };
}

function page(status, text, headers = {}) {
  return new Response(text + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 302, headers });
}

/**
 * Sign-in for the UI, or null when ${dir}/github.json is missing. user(request) is the signed-in {login, name} or null;
 * route(request, step) serves /api/auth/<step>. fetch is injectable so tests never call GitHub.
 */
export function createAuth({ dir, stateDir, origin, fetch: get = fetch, now = Date.now }) {
  const settings = loadGithubConfig(dir);
  if (!settings) return null;
  if (!origin) throw new Error("GitHub sign-in needs AI_COLLAB_UI_ORIGIN for its callback URL");
  const secret = loadSecret(stateDir);
  const callback = origin + "/api/auth/callback";
  const allowed = login => settings.users.includes(String(login).toLowerCase());

  function user(request) {
    const session = verifySession(secret, readCookie(request, SESSION_COOKIE), now());
    return session && allowed(session.login) ? { login: session.login, name: session.name } : null;
  }

  // The GitHub account behind an authorization code; the access token is used once and dropped.
  async function account(code) {
    const clientSecret = readFileSync(settings.clientSecretFile, "utf8").trim();
    const tokenRes = await get(TOKEN_URL, {
      method: "POST", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: clientSecret, code, redirect_uri: callback }),
    });
    const token = tokenRes.ok ? (await tokenRes.json().catch(() => ({}))).access_token : undefined;
    if (typeof token !== "string" || !token) return null;
    const userRes = await get(USER_URL, {
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", authorization: "Bearer " + token, "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" },
    });
    const profile = userRes.ok ? await userRes.json().catch(() => null) : null;
    return isGithubLogin(profile?.login) ? { login: profile.login, name: typeof profile.name === "string" ? profile.name.slice(0, NAME_MAX) : "" } : null;
  }

  async function route(request, step) {
    if (!STEPS.includes(step)) return page(404, "Unknown route");
    if (step === "me") return Response.json({ enabled: true, user: user(request) }, { headers: { "cache-control": "no-store" } });
    if (step === "logout") {
      if (request.method !== "POST") return page(405, "Method not allowed");
      if (request.headers.get("origin") !== origin) return page(403, "Same-origin request required");
      return new Response(null, { status: 204, headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0), "cache-control": "no-store" } });
    }
    if (step === "login") {
      const state = randomBytes(16).toString("hex");
      const query = new URLSearchParams({ client_id: settings.clientId, redirect_uri: callback, state, scope: "", allow_signup: "false" });
      return redirect(AUTHORIZE_URL + "?" + query, [cookie(STATE_COOKIE, state, STATE_TTL_S)]);
    }
    const url = new URL(request.url);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const clear = cookie(STATE_COOKIE, "", 0);
    const expected = readCookie(request, STATE_COOKIE);
    if (!expected || !state || !safeEqual(state, expected)) return page(400, "Sign-in expired or was not started here; open /api/auth/login again.", { "set-cookie": clear });
    if (!code) return page(400, "GitHub sent no authorization code.", { "set-cookie": clear });
    let found;
    try { found = await account(code); } catch { found = null; }
    if (!found) return page(502, "GitHub sign-in failed; try again.", { "set-cookie": clear });
    if (!allowed(found.login)) return page(403, `GitHub user ${found.login} may not use this AI Collab.`, { "set-cookie": clear });
    const value = signSession(secret, { ...found, exp: Math.floor(now() / 1000) + SESSION_TTL_S });
    return redirect("/", [clear, cookie(SESSION_COOKIE, value, SESSION_TTL_S)]);
  }

  return { user, route, hosted: settings.hosted };
}
