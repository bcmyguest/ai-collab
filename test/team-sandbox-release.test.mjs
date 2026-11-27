// A team's OpenShell sandbox is released when its sessions end: after a runner restart, and when the run reaches done.
import { test, after as afterAll } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter, { sandboxName } from "../runner/adapters/cursor.mjs";
import { teamSandboxName } from "../lib/sandbox.ts";
import { loadConfig } from "../lib/config.ts";
import { runStatus } from "../lib/pattern-runs.ts";
import { saveTeamText } from "../lib/catalog/patterns.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();

function lab() {
  const home = tempDir({ after: afterAll }, "ai-collab-team-release-");
  const root = path.join(home, "repo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, version]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  writeFileSync(path.join(root, "host.txt"), "host\n");
  git(root, "add", "host.txt");
  git(root, "commit", "--quiet", "-m", "init");
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  return { home, root, env };
}

const names = (t) => (existsSync(t.env.FAKE_OPENSHELL_STATE) ? JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes : []).map((s) => s.name);
const inside = (t, sandbox, cwd) => path.join(path.dirname(t.env.FAKE_OPENSHELL_STATE), "sandboxes", sandbox, "work", path.basename(cwd));
const ctx = () => ({ emit() {}, log() {}, signal: new AbortController().signal });
const record = (t, over = {}) => ({
  address: "cursor#aaaaaaaaaaaaaaaa", project: "demo", cwd: t.root, place: "openshell", status: "idle", nativeId: "native", ...over,
});
const openOptions = (t, over = {}) => ({
  project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: t.env, ...over,
});

test("a session restored after a runner restart syncs its edits back and deletes its team sandbox on close", async () => {
  const t = lab();
  const run = "mwu2yt0obe8df3";
  const sandbox = teamSandboxName("demo", run);
  // The first runner opened the session and died: its in-memory claim is gone, its sandbox and edits are not.
  const before = cursorAdapter({ env: t.env });
  await before.open(openOptions(t, { patternRun: run }), ctx());
  writeFileSync(path.join(inside(t, sandbox, t.root), "made-inside.txt"), "from the sandbox\n");
  assert.deepEqual(names(t), [sandbox]);

  const after = cursorAdapter({ env: t.env });
  const lost = record(t, { patternRun: run });
  after.restore(lost, ctx(), t.env);
  assert.deepEqual(names(t), [sandbox], "restoring a session does not touch its sandbox");
  assert.equal(await after.release(lost), true);

  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "from the sandbox\n", "the edit reaches the host worktree");
  assert.deepEqual(names(t), [], "the sandbox is deleted");
  await before.shutdown();
});

test("a sandbox another live session still holds is not deleted when a restored session closes", async () => {
  const t = lab();
  const sandbox = sandboxName("demo");
  const adapter = cursorAdapter({ env: t.env });
  const live = await adapter.open(openOptions(t), ctx());
  const restoredRecord = record(t);
  adapter.restore(restoredRecord, ctx(), t.env);
  writeFileSync(path.join(inside(t, sandbox, t.root), "kept.txt"), "still here\n");

  await adapter.release(restoredRecord);
  assert.deepEqual(names(t), [sandbox], "the live session keeps the sandbox");
  assert.equal(readFileSync(path.join(t.root, "kept.txt"), "utf8"), "still here\n", "the restored close still syncs its edits");

  await live.close();
  assert.deepEqual(names(t), [], "the last claim deletes it");
  await adapter.shutdown();
});

test("two restored sessions share one claim count: the sandbox goes with the second close", async () => {
  const t = lab();
  const sandbox = sandboxName("demo");
  const before = cursorAdapter({ env: t.env });
  await before.open(openOptions(t), ctx());
  const adapter = cursorAdapter({ env: t.env });
  const one = record(t, { address: "cursor#1111111111111111" });
  const two = record(t, { address: "cursor#2222222222222222" });
  adapter.restore(one, ctx(), t.env);
  adapter.restore(two, ctx(), t.env);
  adapter.restore(two, ctx(), t.env);
  await adapter.release(one);
  assert.deepEqual(names(t), [sandbox]);
  await adapter.release(two);
  assert.deepEqual(names(t), []);
  await before.shutdown();
});

test("a restored session that is not in OpenShell, or already ended, claims nothing", async () => {
  const t = lab();
  const adapter = cursorAdapter({ env: t.env });
  adapter.restore(record(t, { place: "worktree" }), ctx(), t.env);
  adapter.restore(record(t, { status: "ended" }), ctx(), t.env);
  assert.equal(await adapter.release(record(t, { place: "worktree" })), true);
  assert.deepEqual(names(t), []);
  assert.ok(!existsSync(t.env.FAKE_OPENSHELL_LOG), "openshell is never called");
});

// A runner over the cursor adapter in a throwaway project that is a git repository.
async function cursorRunner(fake) {
  const t = setup(fake);
  const helper = (name) => path.join(HERE, "helpers", name);
  Object.assign(t.env, {
    AI_COLLAB_CURSOR_BIN: helper("fake-cursor-agent.mjs"), AI_COLLAB_OPENSHELL_BIN: helper("fake-openshell.mjs"),
    FAKE_SANDBOX_CURSOR_BIN: helper("fake-cursor-agent.mjs"), FAKE_OPENSHELL_STATE: path.join(t.home, "openshell.json"),
    FAKE_CURSOR_LOG: path.join(t.home, "cursor.log"),
  });
  t.env.AI_COLLAB_PEERS += ",cursor";
  t.cfg = loadConfig(t.env, { cwd: t.root });
  execFileSync("git", ["init", "--quiet", "--template=", t.root], { env: t.env });
  execFileSync("git", ["-C", t.root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "Initial commit"], { env: t.env });
  return t;
}

test("closing a session the runner restored after a restart releases its sandbox", async (testCtx) => {
  // The first runner still lives here, so its close races the second's landing and may keep a sandbox-back dir.
  const tmp = tempDir(testCtx, "ai-collab-team-tmp-");
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  testCtx.after(() => { process.env.TMPDIR = savedTmp; });
  const fake = await startFakeNtfy();
  const t = await cursorRunner(fake);
  const first = makeRunner(t, [cursorAdapter({ env: t.env })]);
  let second;
  try {
    await first.runner.boot();
    const started = await first.runner.start({ project: "demo", harness: "cursor", place: "openshell", prompt: "offline smoke" });
    await until(() => first.runner.get(started.session).status === "idle", "idle session");
    const { cwd } = first.runner.get(started.session);
    const sandbox = sandboxName("demo");
    assert.deepEqual(names(t), [sandbox]);
    writeFileSync(path.join(inside(t, sandbox, cwd), "made-inside.txt"), "from the sandbox\n");

    // A restart without a clean stop: the durable log and the sandbox survive, the process and its claims do not.
    await first.durable.close();
    second = makeRunner(t, [cursorAdapter({ env: t.env })]);
    assert.equal((await second.runner.boot()).length, 1);
    assert.equal(second.runner.get(started.session).status, "idle");
    assert.deepEqual(await second.runner.close(started.session), { status: "ended" });

    assert.equal(readFileSync(path.join(cwd, "made-inside.txt"), "utf8"), "from the sandbox\n");
    assert.deepEqual(names(t), [], "the sandbox is deleted");
  } finally {
    await second?.runner.stop();
    await first.runner.stop().catch(() => {});
    await fake.close();
    rmSync(t.home, { recursive: true, force: true });
  }
});

test("a run that reaches done closes its role sessions and releases its team sandbox", async () => {
  const fake = await startFakeNtfy();
  const t = await cursorRunner(fake);
  const { runner, durable } = makeRunner(t, [cursorAdapter({ env: t.env })]);
  try {
    await runner.boot();
    await saveTeamText(t.cfg, "solo", `digraph solo {
      worker [agent=cursor, prompt="Work"];
      worker -> done [on="finished"];
    }`, t.env, {});
    const started = await runner.startPattern({ project: "demo", name: "solo", task: "Ship it" });
    assert.equal(started.status, "running");
    const sandbox = teamSandboxName("demo", started.id);
    assert.deepEqual(names(t), [sandbox], "the run's roles share one team sandbox");
    const { cwd } = runner.get(started.session);
    writeFileSync(path.join(inside(t, sandbox, cwd), "made-inside.txt"), "from the sandbox\n");

    const done = await runner.advancePattern({ project: "demo", id: started.id, event: "finished", override: true, by: "operator" });
    assert.equal(done.status, "done");
    await durable.result(`pattern-${started.id}`);

    assert.equal(runStatus(t.cfg, started.id).status, "done");
    assert.equal(runner.get(started.session).status, "ended", "the role's session is closed");
    assert.deepEqual(names(t), [], "the team sandbox is released");
    assert.equal(readFileSync(path.join(cwd, "made-inside.txt"), "utf8"), "from the sandbox\n", "its edits reached the host worktree");
  } finally {
    await runner.stop();
    await fake.close();
    rmSync(t.home, { recursive: true, force: true });
  }
});
