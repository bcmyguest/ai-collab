import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { listSessions, recordSession } from "../lib/sessions.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";

test("MCP interrupt rejects unknown sessions and reports Claude sessions unsupported", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: "alice,claude" });
  const claudeId = "11111111-2222-3333-4444-555555555555";
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: "claude" }, { session: sessionLabel(claudeId) });
  await recordSession(cfg, { id: claudeId, cwd: "/tmp", harness: "claude", event: "SessionStart" });
  const [target] = listSessions(cfg);
  assert.ok(target, "session recorded");
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function request(method, params) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const response = JSON.parse((await output.next()).value);
    assert.equal(response.id, id);
    return response.result;
  }
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const unknown = await request("tools/call", { name: "interrupt", arguments: { to: "codex#0123456789abcdef" } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown session/);
  const claude = await request("tools/call", { name: "interrupt", arguments: { to: target.id } });
  assert.equal(claude.isError, undefined);
  assert.equal(JSON.parse(claude.content[0].text).status, "unsupported");
});
