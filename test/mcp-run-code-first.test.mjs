// defaults.json "readsThroughRunCode": direct read-tool calls are refused with a run_code recipe, while OpenShell exists.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));

async function server(t, { setting, openshell }) {
  const fake = await startFakeNtfy();
  const base = peerEnv(fake, { peer: "alice" });
  const config = tempDir({ after }, "ai-collab-rcf-");
  mkdirSync(path.join(config, "ai-collab"), { recursive: true });
  writeFileSync(path.join(config, "ai-collab", "defaults.json"), JSON.stringify(setting === undefined ? {} : { readsThroughRunCode: setting }));
  const bin = tempDir({ after }, "ai-collab-rcf-bin-");
  if (openshell) { writeFileSync(path.join(bin, "openshell"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, "openshell"), 0o755); }
  const env = { ...base, XDG_CONFIG_HOME: config, PATH: `${bin}:${path.dirname(process.execPath)}`, AI_COLLAB_OPENSHELL_BIN: "" };
  const child = spawn(process.execPath, [SCRIPT, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    return JSON.parse((await output.next()).value).result;
  };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const call = (name, args = {}) => request("tools/call", { name, arguments: args });
  call.list = async () => (await request("tools/list", {})).tools;
  return call;
}

test("with readsThroughRunCode on and OpenShell present, a direct read tool answers with the run_code recipe", { timeout: 10000 }, async (t) => {
  const call = await server(t, { setting: true, openshell: true });
  const result = await call("channel_history", { limit: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /run_code/);
  assert.match(result.content[0].text, /ai\.channel_history\(/);
  const listed = await call.list();
  const describe = (name) => listed.find((tool) => tool.name === name)?.description ?? "";
  assert.match(describe("task_list"), /^Do not call directly: call run_code .*ai\.task_list/, "read tools stay listed but point at run_code");
  assert.doesNotMatch(describe("send"), /run_code/);
  const write = await call("set_identity", { activity: "x" });
  assert.doesNotMatch(write.content[0].text, /run_code/, "tools run_code cannot call stay direct");
});

test("without the setting, or without OpenShell, read tools stay direct", { timeout: 10000 }, async (t) => {
  for (const opts of [{ setting: undefined, openshell: true }, { setting: true, openshell: false }]) {
    const call = await server(t, opts);
    const result = await call("channel_history", { limit: 1 });
    assert.doesNotMatch(result.content[0].text, /run_code/, JSON.stringify(opts));
    assert.doesNotMatch((await call.list()).find((tool) => tool.name === "task_list").description, /^Do not call directly/);
  }
});
