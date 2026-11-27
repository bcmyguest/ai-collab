import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.ts";
import { OPS } from "../lib/surfaces/ops.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const LABEL = "aabbccddeeff0123";

// A runner stand-in on a unix socket that records each request and answers one reply.
async function fakeRunner(t, reply = { status: 201, body: { status: "started", session: "codex#0011223344556677", cwd: "/repo" } }) {
  const dir = tempDir({ after }, "spawn-runner-");
  const socket = path.join(dir, "runner.sock");
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socket, seen, dir };
}

const sink = () => { const lines = []; return { lines, write: (s) => lines.push(s) }; };

test("spawn_agent is an MCP tool only, never a run_code tool", () => {
  const op = OPS.find((o) => o.name === "spawn_agent");
  assert.deepEqual(op.surfaces, ["mcp"]);
  assert.equal(op.needsSession, true);
  assert.deepEqual(op.inputSchema.required, ["harness", "brief", "session"]);
  const harness = new RegExp(op.inputSchema.properties.harness.pattern);
  assert.ok(harness.test("opencode:qwen/qwen3-coder"));
  assert.ok(!harness.test("vim"));
});

test("the spawn_agent MCP tool posts a spawn for the calling session", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  const runner = await fakeRunner(t);
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_RUNNER_SOCKET: runner.socket });
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    return JSON.parse((await output.next()).value).result;
  };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.ok((await request("tools/list")).tools.some((tool) => tool.name === "spawn_agent"));
  const result = await request("tools/call", { name: "spawn_agent", arguments: { harness: "codex:gpt-5", brief: "check the tests", session: LABEL } });
  assert.ok(!result.isError, result.content[0].text);
  const started = JSON.parse(result.content[0].text);
  assert.equal(started.session, "codex#0011223344556677");
  assert.equal(runner.seen[0].url, "/v1/sessions");
  assert.deepEqual(runner.seen[0].body, { project: "demo", harness: "codex", prompt: "check the tests", place: "folder", managed: true, parent: `claude#${LABEL}`, spawn: true, system: false, model: "gpt-5" });
});

test("ai-collab spawn prints the child's address and reads the brief from a file or stdin", async (t) => {
  const runner = await fakeRunner(t);
  const brief = path.join(runner.dir, "brief.md");
  writeFileSync(brief, "from a file\n");
  const env = { AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude", AI_COLLAB_SESSION: LABEL, AI_COLLAB_RUNNER_SOCKET: runner.socket, AI_COLLAB_STATE_DIR: runner.dir, HOME: runner.dir };
  const out = sink();
  const err = sink();
  assert.equal(await runCli(["spawn", "codex", "--worktree", "--brief-file", brief], { env, stdout: out, stderr: err }), 0, err.lines.join(""));
  assert.deepEqual(out.lines, ["started codex#0011223344556677 (codex, /repo)\n"]);
  assert.equal(runner.seen[0].body.prompt, "from a file");
  assert.equal(runner.seen[0].body.place, "worktree");
  assert.equal(await runCli(["spawn", "opencode", "--model", "qwen/qwen3", "-"], { env, stdout: sink(), stderr: err, readStdin: async () => "piped" }), 0);
  assert.equal(runner.seen[1].body.prompt, "piped");
  assert.equal(runner.seen[1].body.model, "qwen/qwen3");
});

test("ai-collab spawn exits 2 on a usage error and 1 when the runner refuses or is down", async (t) => {
  const refusing = await fakeRunner(t, { status: 409, body: { error: "spawn depth limit reached" } });
  const env = { AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude", AI_COLLAB_SESSION: LABEL, AI_COLLAB_RUNNER_SOCKET: refusing.socket, AI_COLLAB_STATE_DIR: refusing.dir, HOME: refusing.dir };
  assert.equal(await runCli(["spawn", "codex"], { env, stdout: sink(), stderr: sink() }), 2);
  assert.equal(await runCli(["spawn", "codex", "claude", "--brief", "x"], { env, stdout: sink(), stderr: sink() }), 2);
  assert.equal(await runCli(["spawn", "codex", "--brief", "x", "--bogus"], { env, stdout: sink(), stderr: sink() }), 2);
  const err = sink();
  assert.equal(await runCli(["spawn", "codex", "--brief", "x"], { env, stdout: sink(), stderr: err }), 1);
  assert.match(err.lines.join(""), /spawn depth limit reached/);
  const down = sink();
  assert.equal(await runCli(["spawn", "codex", "--brief", "x"], { env: { ...env, AI_COLLAB_RUNNER_SOCKET: path.join(refusing.dir, "none.sock") }, stdout: sink(), stderr: down }), 1);
  assert.match(down.lines.join(""), /needs the ai-collab runner/);
});

test("close_agent is an MCP tool the spawn_agent description names", () => {
  const op = OPS.find((o) => o.name === "close_agent");
  assert.ok(op, "close_agent exists");
  assert.deepEqual(op.surfaces, ["mcp"]);
  assert.equal(op.needsSession, true);
  assert.deepEqual(op.inputSchema.required, ["to", "session"]);
  assert.match(OPS.find((o) => o.name === "spawn_agent").description, /close_agent/);
});

test("the close_agent MCP tool asks the runner to close a child of the calling session", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  const runner = await fakeRunner(t, { status: 200, body: { status: "ended" } });
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_RUNNER_SOCKET: runner.socket });
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    return JSON.parse((await output.next()).value).result;
  };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const result = await request("tools/call", { name: "close_agent", arguments: { to: "codex#0011223344556677", session: LABEL } });
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { status: "ended", session: "codex#0011223344556677" });
  assert.equal(runner.seen[0].method, "POST");
  assert.equal(runner.seen[0].url, "/v1/sessions/codex/0011223344556677/close-child");
  assert.deepEqual(runner.seen[0].body, { parent: `claude#${LABEL}` });
});
