/**
 * Signed approvals: the signed-in operator allows one exact tool call from the phone, and a PreToolUse hook allows
 * that call once (docs/signed-approvals.md). The UI signs {id, session, tool, inputHash, exp, by} with an Ed25519 key
 * under ${stateDir}/auth; the agent side holds the grant, verifies it with the public key, and burns it on use.
 * A burned grant leaves a .used marker until it expires, so a replayed token is refused.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const INPUT_HASH = /^[a-f0-9]{64}$/;
const GRANT_ID = /^[a-f0-9]{12}$/;
const SESSION = /^[a-f0-9]{16}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TOOL_MAX = 128;
const TOKEN_MAX = 2048;
// Fields that describe a call without changing what it does; a retry may reword them.
const COSMETIC = new Set(["description"]);

const keyFile = (stateDir) => path.join(stateDir, "auth", "grant-ed25519.key");
const pubFile = (stateDir) => path.join(stateDir, "auth", "grant-ed25519.pub");
const grantDir = (stateDir, session) => path.join(stateDir, "grants", session);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** The sha256 of a tool call's input, keys sorted and cosmetic top-level fields dropped. */
export function inputHash(tool, input) {
  const kept = input && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([k]) => !COSMETIC.has(k)))
    : input;
  return createHash("sha256").update(`${tool}\n${canonical(kept)}`).digest("hex");
}

/** The UI's signing key, created once (mode 0600) with its public half beside it; a concurrent creator's key wins. */
export function loadSigner(stateDir) {
  try { return createPrivateKey(readFileSync(keyFile(stateDir), "utf8")); } catch (err) { if (err.code !== "ENOENT") throw err; }
  mkdirSync(path.dirname(keyFile(stateDir)), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  try {
    writeFileSync(keyFile(stateDir), privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    writeFileSync(pubFile(stateDir), publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  return createPrivateKey(readFileSync(keyFile(stateDir), "utf8"));
}

/** The public key that verifies grants, or null before the UI has signed anything. */
export function loadVerifier(stateDir) {
  try { return createPublicKey(readFileSync(pubFile(stateDir), "utf8")); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

function validClaims(c) {
  return c && typeof c === "object" && c.v === 1 && GRANT_ID.test(c.id) && SESSION.test(c.session)
    && typeof c.tool === "string" && c.tool.length > 0 && c.tool.length <= TOOL_MAX && INPUT_HASH.test(c.inputHash)
    && Number.isSafeInteger(c.exp) && typeof c.by === "string" && LOGIN.test(c.by);
}

/** A grant token: base64url(JSON claims) + "." + base64url(Ed25519 signature). */
export function signGrant(privateKey, { id, session, tool, inputHash: hash, by, now = Date.now() }) {
  const claims = { v: 1, id, session, tool, inputHash: hash, exp: now + GRANT_TTL_MS, by };
  if (!validClaims(claims)) throw new Error("Invalid grant");
  const data = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`;
}

/** The claims of a token signed by publicKey and not yet expired, or null. */
export function verifyGrant(publicKey, token, now = Date.now()) {
  if (!publicKey || typeof token !== "string" || token.length > TOKEN_MAX) return null;
  const [data, sig, ...extra] = token.split(".");
  if (!data || !sig || extra.length) return null;
  let ok = false;
  try { ok = verify(null, Buffer.from(data), publicKey, Buffer.from(sig, "base64url")); } catch { return null; }
  if (!ok) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(data, "base64url").toString("utf8")); } catch { return null; }
  return validClaims(claims) && claims.exp > now ? claims : null;
}

/** Stores a verified grant for its session; returns its claims, or null when it is invalid, expired or already used. */
export function storeGrant(stateDir, token, now = Date.now()) {
  const claims = verifyGrant(loadVerifier(stateDir), token, now);
  if (!claims) return null;
  const dir = grantDir(stateDir, claims.session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path.join(dir, `${claims.id}.used`))) return null;
  writeFileSync(path.join(dir, `${claims.id}.grant`), token, { mode: 0o600 });
  return claims;
}

/**
 * Burns the session's grant that matches this exact call and returns its claims, or null when none matches.
 * The rename to .used is the single-use step: of two racing hooks only one rename succeeds. Expired files are swept.
 */
export function takeGrant(stateDir, { session, tool, input, now = Date.now() }) {
  if (!SESSION.test(String(session))) return null;
  const dir = grantDir(stateDir, session);
  let names;
  try { names = readdirSync(dir); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  const publicKey = loadVerifier(stateDir);
  const hash = inputHash(tool, input);
  let taken = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const id = name.replace(/\.(grant|used)$/, "");
    if (name.endsWith(".used")) {
      // A marker outlives its grant only until the grant would have expired.
      let exp = 0;
      try { exp = Number(readFileSync(file, "utf8")) || 0; } catch { /* swept by another hook */ }
      if (exp <= now) rmSync(file, { force: true });
      continue;
    }
    if (!name.endsWith(".grant") || !GRANT_ID.test(id)) continue;
    let token = "";
    try { token = readFileSync(file, "utf8"); } catch { continue; }
    const claims = verifyGrant(publicKey, token, now);
    if (!claims || claims.id !== id || claims.session !== session) { rmSync(file, { force: true }); continue; }
    if (taken || claims.tool !== tool || claims.inputHash !== hash) continue;
    const used = path.join(dir, `${id}.used`);
    try { renameSync(file, used); } catch { continue; }
    writeFileSync(used, String(claims.exp));
    taken = claims;
  }
  return taken;
}

/** PreToolUse output that allows a call a grant covers; {} otherwise. */
export function grantGate(stateDir, { session, tool, input, now = Date.now() }) {
  const claims = takeGrant(stateDir, { session, tool, input, now });
  if (!claims) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      permissionDecisionReason: `Allowed once by ${claims.by}'s signed approval ${claims.id} from the AI Collab phone UI.`,
    },
  };
}
