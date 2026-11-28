// An OpenShell child of a parent on a thread branch starts from it, and each run's sandbox commits land on that branch (docs/threads.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWireEnvelope } from "../lib/agui.ts";
import { loadConfig } from "../lib/config.ts";
import { readOwned } from "../lib/sessions/registry.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { createClaudeSandbox } from "../runner/adapters/cli-sandbox.ts";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const OPENSHELL = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const TO_CODEX = "ai-collab-demo--to--codex";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A fake Claude whose OpenShell sessions run in the real Claude sandbox host over the fake openshell; "commit <file>" commits in the sandbox clone.
function sandboxedClaude(env) {
  const sandbox = createClaudeSandbox({ env });
  const adapter = createFakeAdapter({ harness: "claude", capabilities: { places: ["folder", "worktree", "openshell"] } });
  const open = adapter.open.bind(adapter);
  adapter.open = async (options, ctx) => {
    const handle = await open(options, ctx);
    if (options.place !== "openshell") return handle;
    const box = await sandbox.open({ project: options.project, cwd: options.cwd, home: env.HOME, log: ctx.log });
    const clone = path.join(path.dirname(env.FAKE_OPENSHELL_STATE), "sandboxes", box.name, box.workdir.replace(/^\/sandbox\//, ""));
    const send = handle.send.bind(handle);
    return {
      ...handle,
      send(input) {
        const file = /^commit (\S+)/.exec(input.text)?.[1];
        if (file) {
          writeFileSync(path.join(clone, file), `${file}\n`);
          git(clone, "add", file);
          git(clone, "commit", "--quiet", "-m", `add ${file}`);
        }
        return send(input);
      },
      syncBack: () => box.syncBack(ctx.log),
      async close() { await handle.close(); await box.close(ctx.log); },
    };
  };
  return adapter;
}

async function lab(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(fileEnd, "ai-collab-thread-openshell-");
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  git(root, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(root, "checkout", "--quiet", "-b", "thread/x");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "thread work");
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const claudeBin = path.join(home, "claude-bin");
  writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_OPENSHELL_BIN: OPENSHELL, FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), AI_COLLAB_CLAUDE_BIN: claudeBin,
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  const codex = createFakeAdapter({ harness: "codex" });
  const runner = createRunner({ projects: [cfg], adapters: new Map([["codex", codex], ["claude", sandboxedClaude(env)]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false, startTimeoutMs: 4000 });
  await runner.boot();
  t.after(() => runner.stop());
  const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent", place: "folder" })).session;
  const reports = () => fake.state.publishes.filter((p) => p.topic === TO_CODEX).map((p) => parseWireEnvelope(p.message)).filter((e) => e?.body?.startsWith("[spawn_agent]"));
  return { root, cfg, runner, parent, reports };
}

test("an OpenShell child of a parent on a thread branch starts from it and lands each run's sandbox commits on it", async (t) => {
  const { root, cfg, runner, parent, reports } = await lab(t);
  const { session } = await runner.start({ project: "demo", harness: "claude", prompt: "commit one.txt", place: "folder", managed: true, parent, spawn: true, system: false });
  const record = readOwned(cfg, session.split("#")[1]);
  assert.equal(record.place, "openshell");
  assert.equal(record.spawn.mergeInto, "thread/x");
  const [first] = await until(() => reports().length >= 1 && reports(), "first report");
  assert.match(first.body, /merged 1 commit from \S+ into thread\/x/);
  assert.deepEqual(git(root, "log", "--format=%s", "thread/x").split("\n"), ["add one.txt", "thread work", "init"]);
  // The parent moves its branch on; the next run's commit is rebased onto it and the first one is not merged twice.
  git(root, "commit", "--quiet", "--allow-empty", "-m", "parent work");
  await until(() => runner.get(session).status === "idle", "idle");
  await runner.send(session, { text: "commit two.txt" });
  const second = await until(() => reports()[1], "second report");
  assert.match(second.body, /merged 1 commit from \S+ into thread\/x/);
  assert.deepEqual(git(root, "log", "--format=%s", "thread/x").split("\n"), ["add two.txt", "parent work", "add one.txt", "thread work", "init"]);
  assert.equal(git(root, "show", "thread/x:two.txt"), "two.txt");
  // The child's host branch kept the sandbox's history, so a third run still copies back and merges.
  await until(() => runner.get(session).status === "idle", "idle again");
  await runner.send(session, { text: "commit three.txt" });
  const third = await until(() => reports()[2], "third report");
  assert.match(third.body, /merged 1 commit from \S+ into thread\/x/);
  assert.deepEqual(git(root, "log", "--format=%s", "-2", "thread/x").split("\n"), ["add three.txt", "add two.txt"]);
});
