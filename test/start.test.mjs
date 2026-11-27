import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects, sessionLabel } from "../lib/config.ts";
import { checkPrompt, outputId, startCommand } from "../lib/sessions/launch.ts";
import { createUi } from "../web/server/ui.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const IDS = {
  claude: "11111111-2222-4333-8444-555555555555",
  codex: "22222222-2222-4333-8444-555555555555",
  cursor: "33333333-2222-4333-8444-555555555555",
};
// Fake harness: records argv, cwd and AI_COLLAB_* variables, then prints the id line its real CLI prints first.
const FAKE = (harness) => `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_RECORD + "/${harness}.json", JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), vars: Object.keys(process.env).filter(k => k.startsWith("AI_COLLAB_")).map(k => k + "=" + process.env[k]),
}));
const out = { claude: "Started background session ${IDS.claude}", codex: JSON.stringify({ type: "thread.started", thread_id: "${IDS.codex}" }),
  cursor: JSON.stringify({ type: "system", subtype: "init", session_id: "${IDS.cursor}" }) };
console.log(out["${harness}"]);
`;

async function setup(t, { harnesses = ["claude", "codex", "cursor"] } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-start-");
  const bin = path.join(home, "bin");
  const root = path.join(home, "project");
  const record = path.join(home, "record");
  for (const dir of [bin, root, record, path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  const names = { claude: "claude", codex: "codex", cursor: "cursor-agent" };
  for (const h of harnesses) {
    writeFileSync(path.join(bin, names[h]), FAKE(h));
    chmodSync(path.join(bin, names[h]), 0o755);
  }
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex,cursor" }]));
  const env = {
    HOME: home, PATH: bin + path.delimiter + process.env.PATH, FAKE_RECORD: record, CODEX_HOME: path.join(home, ".codex"),
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SESSION: "aaaaaaaaaaaaaaaa", AI_COLLAB_PEER: "claude", AI_COLLAB_UI_ORIGIN: "x",
  };
  const projects = loadProjects(env, { host: "operator" });
  const ui = createUi({ projects, env });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "start");
  return { ui, post, root, record, bin, home };
}

async function recorded(record, harness) {
  for (let i = 0; i < 200; i++) {
    const file = path.join(record, harness + ".json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    await delay(20);
  }
  throw new Error("fake " + harness + " never ran");
}

test("argv templates, prompt checks, and id parsing", () => {
  assert.deepEqual(startCommand("claude", "/r", "hi"), ["claude", ["--bg", "hi"]]);
  assert.deepEqual(startCommand("codex", "/r", "hi"), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "hi"]]);
  assert.deepEqual(startCommand("cursor", "/r", "hi"), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/r", "hi"]]);
  assert.equal(startCommand("bash", "/r", "hi"), null);
  assert.equal(checkPrompt("  fix it  ").text, "fix it");
  for (const bad of ["", "   ", "--dangerously-skip-permissions", "a\0b", "x".repeat(4001), 42]) assert.ok(checkPrompt(bad).error, String(bad));
  assert.equal(outputId("codex", '{"type":"thread.started","thread_id":"t-1"}\n'), "t-1");
  assert.equal(outputId("cursor", 'noise\n{"type":"system","session_id":"c-1"}\n'), "c-1");
  assert.equal(outputId("claude", "no id here\n"), "");
});

test("a headless Codex run asks for hook trust, since only the TUI can persist it", () => {
  // The flag is on every codex exec argv a start builds, including a sandbox-mode (plan) start and a model start.
  assert.deepEqual(startCommand("codex", "/r", "hi", { model: "gpt-6.2-sol" }),
    ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-m", "gpt-6.2-sol", "hi"]]);
  assert.deepEqual(startCommand("codex", "/r", "hi", { mode: "plan" }),
    ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-s", "read-only", "hi"]]);
  // Nothing else gets a flag that skips trust or permissions.
  assert.ok(!startCommand("claude", "/r", "hi").flat().some((a) => /dangerously|skip-permissions|--force/.test(a)));
  assert.ok(!startCommand("opencode", "/r", "hi").flat().some((a) => /dangerously|skip-permissions|--force/.test(a)));
});

test("each harness starts in the registered folder with the exact argv and a literal prompt", async (t) => {
  const { post, root, record, home } = await setup(t);
  const prompt = "$(touch PWNED); `touch PWNED2` | cat && echo \"$HOME\" > out; 'quoted'";
  const res = await post({ project: "demo", harness: "claude", prompt, cwd: "/etc", root: "/etc" });
  assert.equal(res.status, 201);
  const result = await res.json();
  assert.equal(result.status, "started");
  assert.equal(result.session, "claude#" + sessionLabel(IDS.claude));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(IDS.claude));
  const claude = await recorded(record, "claude");
  assert.deepEqual(claude.argv, ["--bg", "--permission-mode", "default", prompt]);
  assert.equal(claude.cwd, root);
  assert.deepEqual(claude.vars, ["AI_COLLAB_WAKE=1"], "no AI_COLLAB_* settings leak to the child");
  assert.ok(!existsSync(path.join(root, "PWNED")) && !existsSync(path.join(root, "PWNED2")) && !existsSync(path.join(root, "out")));
  assert.match(readFileSync(path.join(home, "state", "demo", "starts", result.log), "utf8"), /Started background session/);

  assert.equal((await post({ project: "demo", harness: "codex", prompt: "second" })).status, 429, "one start per 10 s");
});

test("codex argv carries the hook-trust flag; the other harnesses get no trust-skipping flag", async (t) => {
  for (const harness of ["codex", "cursor"]) {
    const { post, root, record } = await setup(t);
    const result = await (await post({ project: "demo", harness, prompt: "hello there" })).json();
    assert.equal(result.session, `${harness}#${sessionLabel(IDS[harness])}`);
    const run = await recorded(record, harness);
    assert.deepEqual(run.argv, harness === "codex"
      ? ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=true", "hello there"]
      : ["-p", "--trust", "--output-format", "stream-json", "--workspace", root, "hello there"]);
    assert.equal(run.cwd, root);
    assert.equal(result.warning, undefined, "no hook-trust warning: the flag makes the hooks run");
  }
});

test("unknown project, unavailable harness, bad prompt, and client paths are rejected", async (t) => {
  const { ui, post, record } = await setup(t, { harnesses: ["codex"] });
  const statusOf = async (body) => [(await post(body)).status, existsSync(path.join(record, "codex.json"))];
  assert.deepEqual(await statusOf({ project: "other", harness: "codex", prompt: "x" }), [400, false]);
  assert.deepEqual(await statusOf({ project: "demo", harness: "bash", prompt: "x" }), [400, false]);
  assert.deepEqual(await statusOf({ project: "demo", harness: "../codex", prompt: "x" }), [400, false]);
  assert.deepEqual(await statusOf({ project: "demo", harness: "codex", prompt: "--yolo" }), [400, false]);
  assert.deepEqual(await statusOf({ project: "../../etc", harness: "codex", prompt: "x" }), [400, false]);
  const cross = await ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", harness: "codex", prompt: "x" }),
  }), "start");
  assert.equal(cross.status, 403);
});
