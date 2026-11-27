import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV } from "../lib/code-mode.ts";
import { loadProjects, sessionLabel } from "../lib/config.ts";
import { controlSession } from "../lib/sessions/control.ts";
import { listSessions, recordSession, sessionDirectory } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const BASE = "http://127.0.0.1:8795";
const ID = "11111111-2222-4333-8444-555555555555";
const CLI = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));

for (const tag of ["@codex:gpt-6.2-sol", "@codex"]) {
  test(`${tag} launches with required code reads even when the machine setting is off`, async (t) => {
    const fake = await startFakeNtfy();
    const home = tempDir(t, "ai-collab-tagged-code-");
    const config = join(home, "config", "ai-collab");
    const bin = join(home, "bin");
    mkdirSync(config, { recursive: true });
    mkdirSync(bin);
    const env = {
      HOME: home, XDG_CONFIG_HOME: dirname(config), XDG_STATE_HOME: home, XDG_DATA_HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, AI_COLLAB_SCOPE: "off",
    };
    const root = join(home, "project");
    mkdirSync(root);
    writeFileSync(join(config, "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "codex" }]));
    writeFileSync(join(config, "defaults.json"), JSON.stringify({ readsThroughRunCode: false }));
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const cli = spawnSync(process.execPath, [${JSON.stringify(CLI)}, "task", "list"], {
  env: { ...process.env, AI_COLLAB_DIRECT_READS: "1" }, encoding: "utf8",
});
const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents" } };
const mcp = spawnSync(process.execPath, [${JSON.stringify(MCP)}, "codex"], {
  input: JSON.stringify(request) + "\\n", encoding: "utf8",
});
writeFileSync("reads.json", JSON.stringify({ code: cli.status, err: cli.stderr, mcp: mcp.stdout, argv: process.argv.slice(2) }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "${ID}" }));
`, { mode: 0o755 });

    const [cfg] = loadProjects(env, { host: "operator" });
    const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-6.2-sol"] }) });
    t.after(async () => {
      ui.close();
      await fake.close();
      rmSync(home, { force: true, recursive: true });
    });
    const response = await ui.handle(new Request(`${BASE}/api/send`, {
      method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" },
      body: JSON.stringify({ project: "demo", target: "all", body: `${tag} check the queue` }),
    }), "send");
    assert.equal(response.status, 201);
    assert.match((await response.json()).detail, /starting a new session/);
    const reads = JSON.parse(readFileSync(join(root, "reads.json"), "utf8"));
    assert.deepEqual(reads.argv.filter(arg => arg.startsWith("mcp_servers.")), codexRequiredRunCodeArgs().filter(arg => arg !== "-c"));
    assert.equal(reads.code, 3);
    assert.match(reads.err, /ai\.task_list/);
    const { result } = JSON.parse(reads.mcp);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ai\.list_agents/);
  });
}

test("waking a registered tag-launched session keeps reads routed through run_code", async (t) => {
  const stateDir = tempDir(t, "ai-collab-tagged-wake-");
  t.after(() => rmSync(stateDir, { force: true, recursive: true }));
  const cfg = { stateDir, project: "demo", peer: "codex", peers: ["codex"], session: sessionLabel(ID) };
  const record = { id: ID, cwd: stateDir, harness: "codex", proc: { pid: -1, start: "1" } };
  await recordSession(cfg, { ...record, event: "SessionStart", requireRunCode: true });
  await recordSession(cfg, { ...record, event: "SessionEnd" });
  const [session] = listSessions(cfg);
  assert.equal(session.requireRunCode, true);
  assert.match(sessionDirectory(cfg)[0].resume, new RegExp(`^${REQUIRE_RUN_CODE_ENV}=1 codex exec `));

  const result = await controlSession("wake", session, {
    runner: { kind: "host" },
    execute: async (_file, args, { env }) => {
      assert.deepEqual(args.slice(1, -3), codexRequiredRunCodeArgs());
      const read = spawnSync(process.execPath, [CLI, "task", "list"], { env, encoding: "utf8" });
      assert.equal(read.status, 3);
      assert.match(read.stderr, /ai\.task_list/);
      return 0;
    },
  });
  assert.equal(result.status, "succeeded");
});
