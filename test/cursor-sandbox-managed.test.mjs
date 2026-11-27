// A managed Cursor child inside OpenShell gets the subagent block there too; unmanaged sandbox sessions are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter, { prepareSandbox, sandboxName } from "../runner/adapters/cursor.mjs";
import { ensureSandbox } from "../lib/sandbox.ts";
import { tempDir } from "./helpers/tmp.mjs";
import { subagentDenial } from "../lib/subagent-guard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);

function lab(t) {
  const home = tempDir(t, "ai-collab-cursor-managed-");
  const root = path.join(home, "repo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, version]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, "host.txt"), "host\n");
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n");
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  const box = (name) => path.join(home, "sandboxes", name);
  return { home, root, version, env, box };
}

// The subagentStart hook's answer when its command runs through sh with the given env, as Cursor runs hook commands.
function hookAnswer(hooksFile, env) {
  const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(hooks.version, 1);
  const [entry] = hooks.hooks.subagentStart;
  return JSON.parse(execFileSync("sh", ["-c", entry.command], { input: '{"hook_event_name":"subagentStart"}', env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }));
}

const execEnvs = (log) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((a) => a[0] === "sandbox" && a[1] === "exec" && a.includes("cursor-agent"))
  .map((a) => a.flatMap((v, i) => (a[i - 1] === "--env" ? [v] : [])));

test("a managed sandbox child gets AI_COLLAB_MANAGED=1 and a hooks.json whose subagentStart denies", async (t) => {
  const l = lab(t);
  const sandbox = await ensureSandbox({ openshell: OPENSHELL, env: l.env, name: sandboxName("demo") });
  const prepared = await prepareSandbox({ openshell: OPENSHELL, env: l.env, sandbox, cwd: l.root, home: l.home, cursorTree: l.version, managed: true });
  assert.equal(prepared.env.AI_COLLAB_MANAGED, "1");
  const hooksFile = path.join(l.box(sandbox), "home", ".cursor", "hooks.json");
  assert.deepEqual(hookAnswer(hooksFile, { AI_COLLAB_MANAGED: "1" }), subagentDenial("cursor"));
  // The sandbox is shared per project, so an unmanaged session that later reads the same file is let through.
  assert.deepEqual(hookAnswer(hooksFile, {}), {});
});

test("an unmanaged sandbox session gets no managed env and no staged hooks.json", async (t) => {
  const l = lab(t);
  const sandbox = await ensureSandbox({ openshell: OPENSHELL, env: l.env, name: sandboxName("demo") });
  const prepared = await prepareSandbox({ openshell: OPENSHELL, env: l.env, sandbox, cwd: l.root, home: l.home, cursorTree: l.version });
  assert.deepEqual(Object.keys(prepared.env).sort(), ["HOME", "PATH", "XDG_CONFIG_HOME"]);
  assert.equal(existsSync(path.join(l.box(sandbox), "home", ".cursor", "hooks.json")), false);
});

test("the adapter passes AI_COLLAB_MANAGED=1 into the sandbox exec of a managed open and resume, and not an unmanaged one", async (t) => {
  const l = lab(t);
  const ctx = () => ({ emit() {}, log() {}, signal: new AbortController().signal });
  const adapter = cursorAdapter({ env: l.env });
  const base = { project: "demo", cwd: l.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: l.env };
  const managed = await adapter.open({ ...base, managed: true }, ctx());
  const plain = await adapter.open(base, ctx());
  const resumed = await adapter.resume({ ...base, address: "cursor#x", nativeId: managed.nativeId ?? "n1", managed: true }, ctx(), l.env);
  const envs = execEnvs(l.env.FAKE_OPENSHELL_LOG);
  assert.equal(envs.length, 3);
  assert.deepEqual(envs.map((e) => e.includes("AI_COLLAB_MANAGED=1")), [true, false, true]);
  for (const h of [resumed, plain, managed]) await h.close?.();
});
