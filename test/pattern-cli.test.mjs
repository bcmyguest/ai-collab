import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { runCli } from "../lib/cli.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8797";

function project() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-pattern-cli-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex"]) {
    writeFileSync(path.join(bin, name), "#!/bin/sh\n");
    chmodSync(path.join(bin, name), 0o755);
  }
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  return { home, bin, root, stateDir };
}

test("pattern CLI creates, lists, shows, deletes and reports runs", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const p = project();
  writeFileSync(path.join(p.home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root: p.root, project: "demo", url: fake.url, peers: "claude,codex", teams: { crew: ["codex"] } },
  ]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir: p.stateDir, AI_COLLAB_PEERS: "claude,codex", AI_COLLAB_PROJECT: "demo" }), HOME: p.home, PATH: p.bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const out = [];
  const err = [];
  const cli = (argv) => runCli(argv, {
    env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, async readStdin() { return ""; },
  });
  const spec = path.join(p.home, "pair.json");
  writeFileSync(spec, JSON.stringify({
    name: "pair",
    roles: [{ id: "lead", responsibility: "Scope it.", harness: "claude" }, { id: "doer", responsibility: "Do it.", harness: "codex" }],
    handoffs: [{ from: "lead", to: "doer", on: "scope", required: false }, { from: "doer", to: "done", on: "finished", required: true }],
  }));

  assert.equal(await cli(["pattern", "create", spec]), 0);
  assert.equal(out.at(-1), "pattern pair: 2 roles, 2 handoffs\n");
  out.length = 0;
  assert.equal(await cli(["pattern", "list"]), 0);
  assert.match(out.join(""), /fix-and-review\tbuilt-in\t3 roles, 5 handoffs/);
  assert.match(out.join(""), /pair\tproject\t2 roles, 2 handoffs/);
  assert.match(out.join(""), /crew\tteam\t1 members/);
  out.length = 0;
  assert.equal(await cli(["pattern", "show", "pair"]), 0);
  assert.equal(JSON.parse(out.join("")).roles[1].harness, "codex");
  out.length = 0;
  assert.equal(await cli(["pattern", "runs"]), 0);
  assert.equal(out.join(""), "");
  assert.equal(await cli(["pattern", "status", "abcdef1234"]), 1);
  assert.match(err.join(""), /unknown run/);
  assert.equal(await cli(["pattern", "advance", "abcdef1234", "scope"]), 1);
  assert.equal(await cli(["pattern", "delete", "pair"]), 0);
  assert.equal(await cli(["pattern", "delete", "fix-and-review"]), 1);
  assert.match(err.join(""), /is built-in/);
});

test("@pattern in a chat starts a run of the saved pattern with the text as its task", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const p = project();
  writeFileSync(path.join(p.home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root: p.root, project: "demo", url: fake.url, peers: "claude,codex,cursor" },
  ]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir: p.stateDir, AI_COLLAB_PEERS: "claude,codex,cursor" }), HOME: p.home, PATH: p.bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const starts = [];
  const ui = createUi({
    cfg, env,
    models: async () => ({ claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] }),
    start: async (_cfg, options) => { starts.push(options); return { status: "started", session: `${options.harness}#0123456789abcdef`, detail: "ok" }; },
  });
  t.after(() => ui.close());
  const broadcast = await ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ target: "all", body: "@fix-and-review add retry to fetch" }),
  }), "send").then((r) => r.json());
  assert.equal(starts.length, 1);
  assert.equal(starts[0].harness, "claude");
  assert.match(starts[0].prompt, /Pattern "fix-and-review" run .*role "lead"/);
  assert.match(starts[0].prompt, /Task: add retry to fetch/);
  assert.match(broadcast.detail, /@fix-and-review run [a-z0-9]+ running/);
});
