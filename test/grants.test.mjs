// Signed approvals: a grant allows one exact call once, for its own session, until it expires.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GRANT_TTL_MS, grantGate, inputHash, loadSigner, signGrant, storeGrant, takeGrant, verifyGrant } from "../lib/grants.mjs";

const SESSION = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const EDIT = { file_path: "/repo/test/x.test.mjs", old_string: "a", new_string: "b" };
const NOW = 1_800_000_000_000;

function setup(t) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "grants-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const key = loadSigner(stateDir);
  const grant = (over = {}) => signGrant(key, { id: "a1b2c3d4e5f6", session: SESSION, tool: "Edit", inputHash: inputHash("Edit", EDIT), by: "octocat", now: NOW, ...over });
  return { stateDir, key, grant };
}

test("the signing key is private to the user and reused", (t) => {
  const { stateDir, key } = setup(t);
  assert.equal(statSync(path.join(stateDir, "auth", "grant-ed25519.key")).mode & 0o777, 0o600);
  assert.equal(loadSigner(stateDir).export({ type: "pkcs8", format: "pem" }), key.export({ type: "pkcs8", format: "pem" }));
});

test("the input hash ignores key order and the description, and nothing else", () => {
  assert.equal(inputHash("Bash", { command: "ls", description: "a" }), inputHash("Bash", { description: "b", command: "ls" }));
  assert.notEqual(inputHash("Bash", { command: "ls" }), inputHash("Bash", { command: "ls -a" }));
  assert.notEqual(inputHash("Bash", { command: "ls" }), inputHash("Edit", { command: "ls" }));
});

test("a stored grant allows the exact call once", (t) => {
  const { stateDir, grant } = setup(t);
  assert.ok(storeGrant(stateDir, grant(), NOW));
  const out = grantGate(stateDir, { session: SESSION, tool: "Edit", input: EDIT, now: NOW + 1000 });
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /octocat/);
  assert.deepEqual(grantGate(stateDir, { session: SESSION, tool: "Edit", input: EDIT, now: NOW + 2000 }), {});
});

test("a grant does not cover a different input, tool or session", (t) => {
  const { stateDir, grant } = setup(t);
  storeGrant(stateDir, grant(), NOW);
  assert.equal(takeGrant(stateDir, { session: SESSION, tool: "Edit", input: { ...EDIT, new_string: "c" }, now: NOW }), null);
  assert.equal(takeGrant(stateDir, { session: SESSION, tool: "Write", input: EDIT, now: NOW }), null);
  assert.equal(takeGrant(stateDir, { session: OTHER, tool: "Edit", input: EDIT, now: NOW }), null);
  assert.ok(takeGrant(stateDir, { session: SESSION, tool: "Edit", input: EDIT, now: NOW }));
});

test("an expired grant allows nothing", (t) => {
  const { stateDir, grant } = setup(t);
  storeGrant(stateDir, grant(), NOW);
  assert.equal(takeGrant(stateDir, { session: SESSION, tool: "Edit", input: EDIT, now: NOW + GRANT_TTL_MS }), null);
});

test("a used grant cannot be stored again", (t) => {
  const { stateDir, grant } = setup(t);
  const token = grant();
  storeGrant(stateDir, token, NOW);
  assert.ok(takeGrant(stateDir, { session: SESSION, tool: "Edit", input: EDIT, now: NOW }));
  assert.equal(storeGrant(stateDir, token, NOW + 1000), null);
  assert.equal(takeGrant(stateDir, { session: SESSION, tool: "Edit", input: EDIT, now: NOW + 2000 }), null);
});

test("a token signed by another key or altered is refused", (t) => {
  const { stateDir, grant } = setup(t);
  const forged = signGrant(generateKeyPairSync("ed25519").privateKey, { id: "a1b2c3d4e5f6", session: SESSION, tool: "Edit", inputHash: inputHash("Edit", EDIT), by: "octocat", now: NOW });
  assert.equal(storeGrant(stateDir, forged, NOW), null);
  const [data, sig] = grant().split(".");
  const claims = JSON.parse(Buffer.from(data, "base64url").toString());
  const altered = Buffer.from(JSON.stringify({ ...claims, session: OTHER })).toString("base64url");
  assert.equal(storeGrant(stateDir, `${altered}.${sig}`, NOW), null);
  assert.equal(verifyGrant(null, grant(), NOW), null);
});
