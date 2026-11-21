import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPACT_REQUEST, controlSession } from "../lib/controls.mjs";
import { codexLiveCompact } from "../lib/codex-compact.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, parseEnvelope } from "../lib/inbox.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";

const sessionId = "00000000-abcd-1234-9876-000000000002";
const selfStart = (() => { const s = readFileSync("/proc/self/stat", "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; })();
const host = { runner: { kind: "host" } };

// Fake app-server daemon proxy: answers the JSON-RPC calls codexLiveCompact makes and logs every method.
const FAKE_PROXY = `
const fs = require("node:fs");
const [log, loaded, status] = process.argv.slice(2);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
  if (m.id === undefined) return;
  const threadId = m.params?.threadId;
  if (m.method === "thread/loaded/list") return out({ id: m.id, result: { data: loaded ? [loaded] : [], nextCursor: null } });
  if (m.method === "thread/read") return out({ id: m.id, result: { thread: { id: threadId, status: { type: status, ...(status === "active" ? { activeFlags: [] } : {}) } } } });
  out({ id: m.id, result: {} });
  if (m.method === "thread/compact/start") {
    out({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { last: { totalTokens: 250000 } } } });
    out({ method: "item/completed", params: { threadId, item: { type: "contextCompaction" } } });
    out({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { last: { totalTokens: 40000 } } } });
    out({ method: "turn/completed", params: { threadId } });
  }
});
`;

function fakeProxy(loaded, status) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-proxy-"));
  const script = path.join(dir, "proxy.cjs");
  const log = path.join(dir, "log");
  writeFileSync(script, FAKE_PROXY);
  writeFileSync(log, "");
  const methods = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { command: [process.execPath, [script, log, loaded, status]], methods };
}

test("live Codex compaction joins the daemon, checks the thread is idle, and never passes settings to resume", async () => {
  const idle = fakeProxy(sessionId, "idle");
  assert.deepEqual(await codexLiveCompact(sessionId, { cwd: "/tmp", env: process.env, command: idle.command }),
    { status: "compacted", before: 250000, after: 40000 });
  const calls = idle.methods();
  assert.deepEqual(calls.map((c) => c.method), ["initialize", "initialized", "thread/loaded/list", "thread/read", "thread/resume", "thread/compact/start"]);
  assert.deepEqual(calls.find((c) => c.method === "thread/resume").params, { threadId: sessionId });

  const busy = fakeProxy(sessionId, "active");
  assert.deepEqual(await codexLiveCompact(sessionId, { cwd: "/tmp", env: process.env, command: busy.command }), { status: "busy" });
  assert.ok(!busy.methods().some((c) => c.method === "thread/compact/start"));

  const elsewhere = fakeProxy("", "idle");
  assert.deepEqual(await codexLiveCompact(sessionId, { cwd: "/tmp", env: process.env, command: elsewhere.command }), { status: "not-loaded" });
  assert.ok(!elsewhere.methods().some((c) => c.method === "thread/resume"));
});

test("a running session that cannot be compacted from outside gets an urgent request in its operator chat", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor" });
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: "operator" });
  for (const [harness, codexLive, want] of [
    ["claude", undefined, /Remote Control/],
    ["cursor", undefined, /Run \/compact in it\./],
    ["codex", async () => ({ status: "busy" }), /^Codex is mid-turn\. .*press Compact again/],
  ]) {
    const peer = { sessionId, cwd: "/tmp", harness, id: `${harness}#${sessionLabel(sessionId)}`, pid: process.pid, pidStart: selfStart };
    const r = await controlSession("compact", peer, { ...host, cfg, ...(codexLive ? { codexLive } : {}) });
    assert.equal(r.status, "requested", r.detail);
    assert.match(r.detail, want);
    const sent = parseEnvelope(fake.state.publishes.at(-1).message);
    assert.deepEqual([sent.from, sent.to, sent.toSession, sent.operatorThread, sent.urgent, sent.body],
      ["operator", harness, sessionLabel(sessionId), true, true, COMPACT_REQUEST]);
    const agent = loadConfig({ ...env, AI_COLLAB_PEER: harness, AI_COLLAB_SESSION: sessionLabel(sessionId) });
    agent.pollIntervalMs = 60_000;
    const [m] = await claimInbox(agent, { throttle: true });
    assert.equal(m.urgent, true);
  }
  const codex = { sessionId, cwd: "/tmp", harness: "codex", id: `codex#${sessionLabel(sessionId)}`, pid: process.pid, pidStart: selfStart };
  const before = fake.state.publishes.length;
  const done = await controlSession("compact", codex, { ...host, cfg, codexLive: async () => ({ status: "compacted" }) });
  assert.equal(done.status, "succeeded");
  assert.equal(fake.state.publishes.length, before, "no request after a successful live compaction");
});
