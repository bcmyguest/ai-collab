import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { broadcastTopic, inboxTopic, loadConfig } from "../lib/config.ts";
import { approvalMessage, approvalRequest } from "../lib/approvals.ts";
import { askQuestion } from "../lib/questions.ts";
import { createPush, notice } from "../web/server/push.ts";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// http_ece is web-push's own decryption counterpart; resolve it through web-push rather than as a direct dependency.
const ece = createRequire(createRequire(import.meta.url).resolve("web-push"))("http_ece");
const SUBJECT = "mailto:test@example.invalid";
const base = "http://127.0.0.1:8795";

// Local stand-in for FCM or autopush: records each request and answers with the status set for its path.
async function startFakePush() {
  const requests = [];
  const status = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(status.get(req.url) || 201);
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, status, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

// A browser-side subscription: its ECDH key pair and auth secret, as PushSubscription.toJSON() reports them.
function browser(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  return { ecdh, auth, subscription: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth } } };
}

const decrypt = (b, body) => JSON.parse(ece.decrypt(body, { version: "aes128gcm", privateKey: b.ecdh, authSecret: b.auth }).toString());

function checkVapid(headers, origin, publicKey) {
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(headers.authorization);
  assert.ok(match, "VAPID authorization header");
  assert.equal(match[2], publicKey);
  const [head, claims, signature] = match[1].split(".");
  const raw = Buffer.from(match[2], "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(head + "." + claims), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), "ES256 signature");
  const jwt = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(jwt.aud, origin);
  assert.equal(jwt.sub, SUBJECT);
  assert.ok(jwt.exp * 1000 > Date.now());
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const tmp = () => tempDir({ after }, "ai-collab-push-");

test("push sender encrypts with VAPID, keeps keys 0600, dedupes across restarts, and drops gone subscriptions", async (t) => {
  const fake = await startFakePush();
  t.after(() => fake.close());
  const dir = tmp();
  const logs = [];
  const push = createPush({ dir, subject: SUBJECT, allowHttp: true, log: line => logs.push(line) });
  const phone = browser(fake.url + "/send/phone");
  const laptop = browser(fake.url + "/send/laptop");
  const old = browser(fake.url + "/send/old");
  assert.throws(() => push.subscribe({ endpoint: "ftp://x", keys: phone.subscription.keys }), /Invalid push subscription/);
  for (const b of [phone, laptop, old]) push.subscribe(b.subscription);

  const vapid = JSON.parse(readFileSync(path.join(dir, "vapid.json"), "utf8"));
  assert.equal(push.publicKey(), vapid.publicKey);
  for (const file of ["vapid.json", "subscriptions.json"]) assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  assert.equal(createPush({ dir, subject: SUBJECT }).publicKey(), vapid.publicKey, "keys persist");

  fake.status.set("/send/old", 410);
  fake.status.set("/send/laptop", 500);
  const message = notice({ project: "demo", kind: "approval", id: "a1b2c3d4e5f6", sender: "claude#00000000000000aa", harness: "claude", tool: "Bash", text: "git push " + "x".repeat(400), important: true });
  assert.deepEqual(await push.notify("demo:a1b2c3d4e5f6", message), { sent: 1, gone: 1, failed: 1 });
  assert.equal(fake.requests.length, 3);
  const sent = fake.requests.find(r => r.path === "/send/phone");
  assert.equal(sent.headers["content-encoding"], "aes128gcm");
  assert.equal(sent.headers["content-type"], "application/octet-stream");
  assert.equal(sent.headers.urgency, "high");
  assert.equal(sent.headers.topic, "a1b2c3d4e5f6");
  assert.ok(Number(sent.headers.ttl) > 0);
  checkVapid(sent.headers, fake.url, vapid.publicKey);
  assert.ok(!sent.body.includes("git push"), "payload is encrypted");
  const payload = decrypt(phone, sent.body);
  assert.equal(payload.title, "Approve Bash · claude#00000000000000aa");
  assert.equal(payload.tag, "a1b2c3d4e5f6");
  assert.equal(payload.important, true);
  assert.equal(payload.url, "/#project=demo&level=session&harness=claude&session=claude%2300000000000000aa");
  assert.ok(payload.body.length <= 200 && payload.body.startsWith("git push"));

  assert.deepEqual(push.subscriptions().map(s => s.endpoint), [phone.subscription.endpoint, laptop.subscription.endpoint], "410 removed, 500 kept");
  fake.status.set("/send/laptop", 404);
  assert.equal((await push.send({ title: "t", tag: "test" }, { endpoint: laptop.subscription.endpoint })).gone, 1);
  assert.deepEqual(push.subscriptions().map(s => s.endpoint), [phone.subscription.endpoint], "404 removed");

  const before = fake.requests.length;
  assert.equal((await push.notify("demo:a1b2c3d4e5f6", message)).duplicate, true);
  assert.equal((await createPush({ dir, subject: SUBJECT, allowHttp: true }).notify("demo:a1b2c3d4e5f6", message)).duplicate, true, "dedupe survives restart");
  assert.equal(fake.requests.length, before);
  assert.equal(statSync(path.join(dir, "sent.json")).mode & 0o777, 0o600);
  const secrets = [vapid.privateKey, "/send/", phone.auth];
  assert.ok(logs.length && logs.every(line => secrets.every(s => !line.includes(s))), "logs carry no keys or endpoint paths");
});

test("UI server notifies new approvals, choices, questions, and operator messages from the hub, once each", async (t) => {
  const ntfy = await startFakeNtfy();
  const pushServer = await startFakePush();
  t.after(() => Promise.all([ntfy.close(), pushServer.close()]));
  const cfg = loadConfig(peerEnv(ntfy, { peer: "alice" }));
  const bob = { ...loadConfig(peerEnv(ntfy, { peer: "bob" })), session: "0000000000000001" };
  const topic = broadcastTopic("demo");
  const ask = (input, id) => approvalMessage(bob, "claude", approvalRequest("claude", "permissionrequest", input), { id, expiresAt: Date.now() + 600_000 });
  // Already answered or closed before the server starts: no notification.
  ntfy.inject(topic, ask({ tool_name: "Bash", tool_input: { command: "ls" } }, "aaaaaaaaaaa1"));
  ntfy.inject(topic, "reply aaaaaaaaaaa1 allow");
  ntfy.inject(topic, ask({ tool_name: "Bash", tool_input: { command: "pwd" } }, "aaaaaaaaaaa2"));
  ntfy.inject(topic, JSON.stringify({ v: 1, kind: "approval-end", from: "bob", id: "aaaaaaaaaaa2", reason: "timeout" }));

  const dir = tmp();
  const phone = browser(pushServer.url + "/send/phone");
  const start = () => createUi({ cfg, allowedOrigin: "https://ui.example.test", push: createPush({ dir, subject: SUBJECT, allowHttp: true }) });
  const ui = start();
  t.after(() => ui.close());
  const call = (method, action, body, origin = "https://ui.example.test") => ui.push(new Request(`${base}/api/push/${action}`, {
    method, headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), action);
  const key = await (await ui.push(new Request(`${base}/api/push/key`), "key")).json();
  assert.match(key.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal((await call("POST", "subscribe", { subscription: phone.subscription }, "https://evil.example")).status, 403);
  assert.equal((await call("POST", "subscribe", { subscription: { endpoint: "nope" } })).status, 400);
  assert.equal((await call("POST", "subscribe", { subscription: phone.subscription })).status, 201);
  assert.equal((await call("POST", "test", { endpoint: phone.subscription.endpoint })).status, 201);
  await until(() => pushServer.requests.length === 1);
  assert.equal(decrypt(phone, pushServer.requests[0].body).tag, "test");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(pushServer.requests.length, 1, "closed and answered history stays silent");

  ntfy.inject(topic, ask({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, "bbbbbbbbbbb1"));
  ntfy.inject(topic, ask({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which framework?", header: "Framework", options: [{ label: "React" }, { label: "Vue" }] }] } }, "bbbbbbbbbbb2"));
  await askQuestion(bob, "Merge now?", { seconds: 0, important: true });
  await askQuestion(bob, "Update the README?", { seconds: 0 });
  const dm = { v: 1, kind: "msg", from: "bob", session: bob.session, to: "operator", operatorThread: true, body: "Done with the refactor" };
  ntfy.inject(inboxTopic("demo", "bob"), JSON.stringify(dm));
  ntfy.inject(inboxTopic("demo", "bob"), JSON.stringify({ ...dm, to: "carol", operatorThread: false, body: "peer chat" }));
  await until(() => pushServer.requests.length === 6);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(pushServer.requests.length, 6);
  const got = pushServer.requests.slice(1).map(r => decrypt(phone, r.body));
  const by = kind => got.filter(p => p.kind === kind);
  const sender = "bob#0000000000000001";
  assert.deepEqual(by("approval").map(p => [p.title, p.body, p.tag, p.important]), [["Approve Bash · " + sender, "git push origin main", "bbbbbbbbbbb1", true]]);
  assert.deepEqual(by("choice").map(p => [p.body, p.tag, p.harness]), [["Which framework?", "bbbbbbbbbbb2", "claude"]]);
  assert.deepEqual(by("question").map(p => [p.title, p.body, p.important]).sort(), [
    ["Important question · " + sender, "Merge now?", true], ["Question · " + sender, "Update the README?", false]]);
  assert.deepEqual(by("message").map(p => [p.body, p.session, p.important]), [["Done with the refactor", sender, false]]);
  assert.ok(got.every(p => p.project === "demo" && p.url.includes("session=bob%230000000000000001")));
  assert.equal(ntfy.state.publishes.filter(p => p.topic !== topic).length, 0, "nothing published beyond the agent's own questions");

  // A restarted server reloads the same history and sends nothing again.
  ui.close();
  const again = start();
  t.after(() => again.close());
  await until(() => ntfy.state.polls.filter(p => p.topic === topic).length >= 2);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(pushServer.requests.length, 6);

  assert.equal((await call("DELETE", "subscribe", { endpoint: phone.subscription.endpoint })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "subscriptions.json"), "utf8")), []);
});
