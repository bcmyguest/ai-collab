// OpenShell sandboxes carry ai-collab labels: creates pass them, and the cap and cleanup select by them, not by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter from "../runner/adapters/cursor.mjs";
import * as sandbox from "../runner/sandbox.mjs";
import { ensureSandbox, sandboxCapRefusal, teamSandboxName } from "../runner/sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
chmodSync(OPENSHELL, 0o755);
chmodSync(CURSOR, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const managed = (project, kind, owner) => ({
  "ai-collab.managed": "true", "ai-collab.project": project, "ai-collab.kind": kind, "ai-collab.owner": owner, "ai-collab.version": VERSION,
});

// A home whose fake openshell holds the given sandbox records, a git project "demo", and a cursor tree.
function lab(records = []) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-labels-"));
  const root = path.join(home, "demo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.25-fake");
  for (const dir of [root, version, path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const state = path.join(home, "openshell.json");
  writeFileSync(state, JSON.stringify({ sandboxes: records }));
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: state, FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  return { home, root, state, env };
}
const stored = (l) => JSON.parse(readFileSync(l.state, "utf8")).sandboxes;
const names = (l) => stored(l).map((s) => s.name);
const record = (name, labels, phase = "Ready") => ({ name, phase, labels });
const ctx = (logs = []) => ({ emit() {}, log: (line) => logs.push(line), signal: new AbortController().signal });

test("ensureSandbox passes the full label set on create", async () => {
  const l = lab();
  await ensureSandbox({ openshell: OPENSHELL, env: l.env, name: "team-1", labels: managed("demo", "team", "run1") });
  assert.deepEqual(stored(l), [{
    name: "team-1", phase: "Ready",
    labels: {
      "ai-collab.managed": "true", "ai-collab.project": "demo", "ai-collab.kind": "team",
      "ai-collab.owner": "run1", "ai-collab.version": VERSION,
    },
  }]);
});

test("the cap counts this project's managed sandboxes and ignores other projects and unmanaged ones", async () => {
  const otherProject = [1, 2, 3, 4, 5, 6].map((n) => record(`x-${n}`, managed("other", "builder", "b1")));
  const unmanaged = record("b-zz-000001", { "ai-collab.owner": "someone" });
  const l = lab([...otherProject, unmanaged, record("ai-collab-code", { "ai-collab.managed": "true", "ai-collab.kind": "code" })]);
  assert.equal(await sandboxCapRefusal({ openshell: OPENSHELL, env: l.env, name: "new", project: "demo" }), "");

  const mine = [1, 2, 3, 4, 5, 6].map((n) => record(`m-${n}`, managed("demo", "builder", `b${n}`)));
  const full = lab([...otherProject, ...mine]);
  const refusal = await sandboxCapRefusal({ openshell: OPENSHELL, env: full.env, name: "new", project: "demo" });
  assert.match(refusal, /6 OpenShell sandboxes are running \(m-1, m-2, m-3, m-4, m-5, m-6\); the cap is 6/);
});

test("listManagedSandboxes selects by project, kind and owner; a legacy name is used only when unlabelled", async () => {
  const demoRun1 = teamSandboxName("demo", "run1");
  const otherRun2 = teamSandboxName("demo", "run2");
  const unmanagedRun3 = teamSandboxName("demo", "run3");
  const legacyRun4 = teamSandboxName("demo", "run4");
  const l = lab([
    record(demoRun1, managed("demo", "team", "run1")),
    record(otherRun2, managed("other", "team", "run2")),
    record(unmanagedRun3, { "ai-collab.kind": "team", "ai-collab.owner": "run3" }),
    record(legacyRun4, {}),
  ]);
  const owned = (owner, legacyNames) => sandbox.listManagedSandboxes({ openshell: OPENSHELL, env: l.env, project: "demo", kind: "team", owner, legacyNames });
  assert.deepEqual((await owned("run1", [demoRun1])).map((s) => [s.name, s.legacy]), [[demoRun1, false]]);
  assert.deepEqual(await owned("run2", [otherRun2]), [], "another project's sandbox is never selected");
  assert.deepEqual(await owned("run3", [unmanagedRun3]), [], "an unmanaged sandbox is never selected");
  assert.deepEqual((await owned("run4", [legacyRun4])).map((s) => [s.name, s.legacy]), [[legacyRun4, true]]);
});

test("a team release deletes only the team's own sandbox, not another project's with the same name", async () => {
  const run = "mwu2yt0obe8df3";
  const sandbox = teamSandboxName("demo", run);
  const l = lab([record(sandbox, managed("other", "team", run))]);
  const adapter = cursorAdapter({ env: l.env });
  const restored = { address: "cursor#aaaaaaaaaaaaaaaa", project: "demo", cwd: l.root, place: "openshell", status: "idle", nativeId: "native", patternRun: run };
  const logs = [];
  adapter.restore(restored, ctx(logs), l.env);
  assert.equal(await adapter.release(restored), true);
  assert.deepEqual(names(l), [sandbox], "the other project's sandbox survives");
  await adapter.shutdown();
});

test("a team release deletes an unlabelled sandbox under its name and logs the legacy match", async () => {
  const run = "legacy-run-1";
  const sandbox = teamSandboxName("demo", run);
  const l = lab([record(sandbox, {})]);
  const adapter = cursorAdapter({ env: l.env });
  const restored = { address: "cursor#bbbbbbbbbbbbbbbb", project: "demo", cwd: l.root, place: "openshell", status: "idle", nativeId: "native", patternRun: run };
  const logs = [];
  adapter.restore(restored, ctx(logs), l.env);
  assert.equal(await adapter.release(restored), true);
  assert.deepEqual(names(l), [], "the unlabelled team sandbox is deleted by name");
  assert.match(logs.join("\n"), /legacy/);
  await adapter.shutdown();
});
