// Pins the MCP stdio surface every ai-collab server shares, so swapping its implementation keeps the wire behaviour.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-mcp-surface.mjs");
const CLIENT = { capabilities: {}, clientInfo: { name: "test", version: "1" } };

function start(t) {
  const child = spawn(process.execPath, [SERVER, "--serve"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const waiting = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 1;
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params, id = next++) => new Promise((resolve) => {
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  });
  return { child, write, request, stderr: () => stderr };
}

async function ready(t) {
  const server = start(t);
  await server.request("initialize", { protocolVersion: "2025-06-18", ...CLIENT });
  server.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  return server;
}

test("initialize echoes a known protocol version and reports name, version, instructions and tools", async (t) => {
  const { request } = start(t);
  const reply = await request("initialize", { protocolVersion: "2025-06-18", ...CLIENT });
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.deepEqual(reply.result.serverInfo, { name: "fake", version: "9.9.9" });
  assert.equal(reply.result.instructions, "Fake instructions.");
  assert.ok(reply.result.capabilities.tools);
});

test("initialize answers an unknown protocol version with one it supports", async (t) => {
  const { request } = start(t);
  const reply = await request("initialize", { protocolVersion: "1999-01-01", ...CLIENT });
  assert.match(reply.result.protocolVersion, /^20\d\d-\d\d-\d\d$/);
  assert.notEqual(reply.result.protocolVersion, "1999-01-01");
});

test("tools/list passes tool definitions through unchanged", async (t) => {
  const { request } = await ready(t);
  const reply = await request("tools/list", {});
  assert.deepEqual(reply.result.tools.map((tool) => tool.name), ["echo", "slow"]);
  assert.deepEqual(reply.result.tools[0].inputSchema.required, ["text"]);
  assert.equal(reply.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(reply.result.tools[0].annotations, { readOnlyHint: true });
});

test("tools/call returns text content, isError results, and a thrown error as an isError result", async (t) => {
  const { request } = await ready(t);
  const ok = await request("tools/call", { name: "echo", arguments: { text: "hi" } });
  assert.deepEqual(ok.result, { content: [{ type: "text", text: "{\"text\":\"hi\"}" }] });
  const refused = await request("tools/call", { name: "refuse", arguments: {} });
  assert.deepEqual(refused.result, { isError: true, content: [{ type: "text", text: "refused" }] });
  const thrown = await request("tools/call", { name: "boom", arguments: {} });
  assert.deepEqual(thrown.result, { isError: true, content: [{ type: "text", text: "boom failed" }] });
});

test("tools/call without arguments passes an empty object", async (t) => {
  const { request } = await ready(t);
  const reply = await request("tools/call", { name: "echo" });
  assert.deepEqual(reply.result.content, [{ type: "text", text: "{}" }]);
});

test("ping answers an empty result", async (t) => {
  const { request } = await ready(t);
  assert.deepEqual((await request("ping")).result, {});
});

test("an unknown method is a -32601 error", async (t) => {
  const { request } = await ready(t);
  const reply = await request("nope/nothing", {});
  assert.equal(reply.error.code, -32601);
});

test("a cancelled call aborts its signal and sends no result", async (t) => {
  const server = await ready(t);
  let answered = false;
  void server.request("tools/call", { name: "slow", arguments: {} }, 77).then(() => { answered = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  server.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 77 } });
  const deadline = Date.now() + 5000;
  while (!server.stderr().includes("slow aborted") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(server.stderr(), /slow aborted/);
  assert.deepEqual((await server.request("ping")).result, {});
  assert.equal(answered, false);
});

test("a line that is not JSON leaves the server answering", async (t) => {
  const server = await ready(t);
  server.child.stdin.write("not json\n");
  assert.deepEqual((await server.request("ping")).result, {});
});
