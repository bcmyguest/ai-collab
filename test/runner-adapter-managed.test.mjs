// Managed sessions in each adapter: native subagents off, set per session, against fakes only (no CLI, no tokens).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import codexAdapter, { APP_SERVER_ARGS } from "../runner/adapters/codex.mjs";
import { createOpenCodeAdapter } from "../runner/adapters/opencode.mjs";
import { permissionSettings } from "../runner/contract.mjs";
import { CODEX_NO_SUBAGENT_ARGS, OPENCODE_NO_SUBAGENTS } from "../lib/subagent-guard.ts";
import { fakeClaudeQuery } from "./helpers/fake-claude-query.mjs";

const FAKE_CODEX = fileURLToPath(new URL("./helpers/fake-codex-app-server.mjs", import.meta.url));
const PASSWORD = "test-password";
const NATIVE = "11111111-2222-4333-8444-555555555555";

const ctx = () => ({ events: [], emit(e) { this.events.push(e); }, log: () => {}, signal: new AbortController().signal });
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// A loopback OpenCode service that records every call and answers the session routes the adapter uses.
async function opencodeService(t) {
  const state = mkdtempSync(path.join(os.tmpdir(), "ai-collab-opencode-managed-"));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
    if (req.url === "/api/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": connected\n\n"); return; }
    const id = req.url === "/api/session" ? "ses_new" : decodeURIComponent(req.url.split("/")[3] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/permission") ? { data: [] } : { data: { id, time: { created: 1, updated: 2, busy: 1, idle: 2 } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  mkdirSync(path.join(state, "opencode"), { recursive: true });
  writeFileSync(path.join(state, "opencode", "service.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password: PASSWORD }));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(state, { recursive: true, force: true }); });
  return { env: { XDG_STATE_HOME: state, PATH: process.env.PATH }, calls };
}

test("a managed Claude session disallows Agent and Task at open and on resume; an unmanaged one does not", async () => {
  const fake = fakeClaudeQuery();
  const adapter = createClaudeAdapter({ query: fake.query, handshakeMs: 1000 });
  const base = { cwd: "/work", permission: { permissionMode: "default" }, env: {} };
  const managed = await adapter.open({ ...base, managed: true }, ctx());
  const plain = await adapter.open(base, ctx());
  const resumed = await adapter.resume({ nativeId: NATIVE, cwd: "/work", permissionMode: "auto", place: "folder", managed: true }, ctx(), {});
  assert.deepEqual(fake.queries[0].options.disallowedTools, ["Agent", "Task"]);
  assert.equal(fake.queries[1].options.disallowedTools, undefined);
  assert.deepEqual(fake.queries[2].options.disallowedTools, ["Agent", "Task"]);
  await Promise.all([managed.close(), plain.close(), resumed.close()]);
});

test("managed Codex sessions run on a second app-server with subagents off; unmanaged ones keep the first", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-managed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "fake.log");
  const adapter = codexAdapter({ command: { file: process.execPath, args: [FAKE_CODEX, ...APP_SERVER_ARGS], version: [FAKE_CODEX, "--version"] } });
  t.after(() => adapter.shutdown());
  const options = (managed) => ({
    project: "p", cwd: dir, place: "folder", permissionMode: "auto", permission: permissionSettings("codex", "auto", "folder").settings,
    env: { PATH: process.env.PATH, FAKE_CODEX_LOG: log }, ...(managed ? { managed: true } : {}),
  });
  await adapter.open(options(false), ctx());
  const managed = await adapter.open(options(true), ctx());
  await adapter.open(options(true), ctx());
  const starts = lines(log).filter((e) => e.kind === "start").map((e) => e.argv);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0], APP_SERVER_ARGS);
  assert.deepEqual(starts[1], [...APP_SERVER_ARGS, ...CODEX_NO_SUBAGENT_ARGS]);
  await adapter.shutdown();
  const record = { nativeId: managed.nativeId, address: "codex#x", cwd: dir, place: "folder", permissionMode: "auto", managed: true };
  await adapter.resume(record, ctx(), { PATH: process.env.PATH, FAKE_CODEX_LOG: log });
  assert.deepEqual(lines(log).filter((e) => e.kind === "start").at(-1).argv, [...APP_SERVER_ARGS, ...CODEX_NO_SUBAGENT_ARGS]);
});

test("a managed OpenCode session carries the subagent deny rule at create and on resume", async (t) => {
  const svc = await opencodeService(t);
  const adapter = createOpenCodeAdapter({ env: svc.env });
  t.after(() => adapter.shutdown());
  await adapter.open({ cwd: "/work", permission: { autoReply: [] }, managed: true }, ctx());
  await adapter.open({ cwd: "/work", permission: { autoReply: [] } }, ctx());
  const creates = svc.calls.filter((c) => c.method === "POST" && c.path === "/api/session");
  assert.deepEqual(creates[0].body.permissions, OPENCODE_NO_SUBAGENTS);
  assert.equal(creates[1].body.permissions, undefined);
  await adapter.resume({ nativeId: "ses_old", permissionMode: "supervised", managed: true }, ctx());
  await adapter.resume({ nativeId: "ses_plain", permissionMode: "supervised" }, ctx());
  const patches = svc.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches, [{ method: "PATCH", path: "/api/session/ses_old", body: { permissions: OPENCODE_NO_SUBAGENTS } }]);
});
