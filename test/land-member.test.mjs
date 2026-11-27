// `land finish` for a sandboxed pattern member: the LAND_FINISH reply line, the host's ownership checks, the Cursor sync and the runner step.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import { finishMemberBranch, landFinishRequest } from "../lib/land-member.ts";
import { runStatus, startRun } from "../lib/pattern-runs.mjs";
import { saveTeamText } from "../lib/patterns.mjs";
import cursorAdapter, { sandboxName } from "../runner/adapters/cursor.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { listenControl, runnerSocket } from "../runner/control.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// finishBranch runs git with this process's env; the host's global config (push hooks) stays out.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();
const RUN = "abc123def";
const ADDRESS = "cursor#0123456789abcdef";

// A repo with a bare origin and the run's worktree on team/<run>, as the runner's placeCwd makes it.
function repo(t) {
  const home = tempDir(t, "ai-collab-land-member-");
  const root = path.join(home, "repo");
  const origin = path.join(home, "origin.git");
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["init", "--quiet", "--bare", "--template=", origin]);
  git(root, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(root, "remote", "add", "origin", origin);
  const worktree = path.join(root, ".claude", "worktrees", `team-${RUN}`);
  git(root, "worktree", "add", "--quiet", "-b", `team/${RUN}`, worktree);
  return { home, root, origin, worktree };
}

const memberRun = (extra = {}) => ({ id: RUN, status: "running", definition: { roles: [{ id: "builder" }], landing: "branch" }, sessions: { builder: ADDRESS }, ...extra });
const member = (worktree, extra = {}) => ({ address: ADDRESS, place: "openshell", cwd: worktree, patternRun: RUN, ...extra });
const noTasks = { add: async () => assert.fail("no task board"), submitReview: async () => assert.fail("no task board") };

test("LAND_FINISH is read from the last line or the line before PATTERN_ADVANCE", () => {
  assert.equal(landFinishRequest("done"), undefined);
  assert.equal(landFinishRequest(undefined), undefined);
  assert.deepEqual(landFinishRequest('Done.\nLAND_FINISH {"proof":" npm test: ok "}'), { proof: "npm test: ok" });
  assert.deepEqual(landFinishRequest('Done.\nLAND_FINISH {"proof":"ok"}\nPATTERN_ADVANCE {"event":"ready"}\n'), { proof: "ok" });
  assert.deepEqual(landFinishRequest("LAND_FINISH {}"), { proof: "" });
  assert.equal(landFinishRequest('LAND_FINISH {"proof":"ok"}\none\ntwo'), undefined, "an older line is not a request");
  assert.match(landFinishRequest("LAND_FINISH not json").error, /LAND_FINISH takes JSON/);
  assert.match(landFinishRequest('LAND_FINISH {"proof":7}').error, /LAND_FINISH takes JSON/);
  assert.equal(landFinishRequest(`LAND_FINISH ${JSON.stringify({ proof: "x".repeat(5000) })}`).proof.length, 3000);
});

test("the host syncs the sandbox, then pushes team/<run> under the run's landing policy", async (t) => {
  const r = repo(t);
  const order = [];
  const result = await finishMemberBranch({
    record: member(r.worktree), run: memberRun(), root: r.root, proof: "ok", tasks: noTasks,
    syncBack: async () => { order.push("sync"); git(r.worktree, "commit", "--quiet", "--allow-empty", "-m", "sandbox work"); },
  });
  assert.deepEqual(order, ["sync"]);
  assert.deepEqual(result, { landing: "branch", branch: `team/${RUN}` });
  assert.equal(git(r.origin, "rev-parse", `refs/heads/team/${RUN}`), git(r.worktree, "rev-parse", "HEAD"));
  assert.throws(() => git(r.origin, "rev-parse", "--verify", "--quiet", "refs/heads/main"), "main is never pushed");
});

test("the landing policy and branch come from the host, and the member's request passes only the proof", async (t) => {
  const r = repo(t);
  const seen = [];
  await finishMemberBranch({
    record: member(r.worktree), run: memberRun({ definition: { roles: [{ id: "builder" }], landing: "packet" } }), root: r.root, proof: "ok", tasks: noTasks,
    syncBack: async () => {}, finish: async (branch, options) => { seen.push({ branch, landing: options.landing, cwd: options.cwd, by: options.by }); return { landing: "packet", task: "t1" }; },
  });
  assert.deepEqual(seen, [{ branch: `team/${RUN}`, landing: "packet", cwd: r.worktree, by: ADDRESS }]);
});

test("the host refuses a request it cannot tie to the caller's own run worktree and branch", async (t) => {
  const r = repo(t);
  const other = path.join(r.home, "other");
  mkdirSync(other);
  let synced = 0;
  const attempt = (record, run, proof = "ok") => finishMemberBranch({ record, run, root: r.root, proof, tasks: noTasks, syncBack: async () => { synced += 1; } });
  await assert.rejects(attempt(member(r.worktree, { place: "worktree" }), memberRun()), /only a sandboxed member/);
  await assert.rejects(attempt(member(r.worktree), null), /not in this pattern run/);
  await assert.rejects(attempt(member(r.worktree, { patternRun: "zzz999zzz" }), memberRun()), /not in this pattern run/);
  await assert.rejects(attempt(member(r.worktree), memberRun({ status: "done" })), /is done/);
  await assert.rejects(attempt(member(r.worktree, { address: "cursor#ffffffffffffffff" }), memberRun()), /not a member of run/);
  await assert.rejects(attempt(member(other), memberRun()), /does not own its run's worktree/);
  await assert.rejects(attempt(member(r.root), memberRun()), /does not own its run's worktree/);
  await assert.rejects(attempt(member(r.worktree), memberRun({ definition: { roles: [{ id: "builder" }] } }), ""), /needs a proof/);
  git(r.worktree, "checkout", "--quiet", "-b", "main-copy");
  await assert.rejects(attempt(member(r.worktree), memberRun()), new RegExp(`on main-copy, not team/${RUN}`));
  git(r.root, "checkout", "--quiet", "--detach");
  git(r.worktree, "checkout", "--quiet", "main");
  await assert.rejects(attempt(member(r.worktree), memberRun()), /on main, not team/);
  assert.equal(synced, 0, "a refused request never touches the sandbox");
  assert.throws(() => git(r.origin, "rev-parse", "--verify", "--quiet", "refs/heads/main"));
});

// The Cursor adapter's OpenShell session over the fake openshell, as test/cursor-sandbox-git.test.mjs sets it up.
function cursorLab(t) {
  const r = repo(t);
  const version = path.join(r.home, "cursor-agent", "versions", "2026.11.22-fake");
  mkdirSync(version, { recursive: true });
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: r.home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(r.home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(r.home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(r.home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  return { ...r, env };
}

test("the Cursor sandbox refuses uncommitted work, then lands its commits on the run worktree", async (t) => {
  const lab = cursorLab(t);
  const handle = await cursorAdapter({ env: lab.env }).open({
    project: "demo", cwd: lab.worktree, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: lab.env,
  }, { emit() {}, log() {}, signal: new AbortController().signal });
  try {
    const inside = path.join(path.dirname(lab.env.FAKE_OPENSHELL_STATE), "sandboxes", sandboxName("demo"), "work", path.basename(lab.worktree));
    writeFileSync(path.join(inside, "work.txt"), "one\n");
    const before = git(lab.worktree, "rev-parse", "HEAD");
    await assert.rejects(handle.syncBack(), /commit your work in the sandbox first/);
    assert.equal(git(lab.worktree, "rev-parse", "HEAD"), before);
    git(inside, "add", "work.txt");
    git(inside, "commit", "--quiet", "-m", "work inside");
    await handle.syncBack();
    assert.equal(git(lab.worktree, "rev-parse", "HEAD"), git(inside, "rev-parse", "HEAD"));
    assert.equal(git(lab.worktree, "rev-parse", "--abbrev-ref", "HEAD"), `team/${RUN}`);
  } finally {
    await handle.close();
  }
});

test("a sandboxed member's LAND_FINISH reply makes the runner push its run branch before the handoff", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  let runner, control;
  try {
    execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", ctx.root]);
    git(ctx.root, "commit", "--quiet", "--allow-empty", "-m", "initial");
    const origin = path.join(ctx.home, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", "--template=", origin]);
    git(ctx.root, "remote", "add", "origin", origin);
    await saveTeamText(ctx.cfg, "ship", `digraph ship {
      graph [landing="branch"];
      builder [agent=claude, prompt="Build"];
      builder -> done [on="finished", required=true];
    }`, ctx.env, {});
    const adapter = createFakeAdapter({ harness: "claude", capabilities: { places: ["openshell"] } });
    const synced = [];
    const open = adapter.open;
    adapter.open = async (options, context) => {
      const handle = await open(options, {
        ...context,
        emit(event) {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK && event.delta.includes('role "builder"')) {
            event = { ...event, delta: 'Built.\nLAND_FINISH {"proof":"npm test: 3 passed"}\nPATTERN_ADVANCE {"event":"finished"}' };
          }
          context.emit(event);
        },
      });
      // Stands in for the Cursor sandbox copy-back: the member's commit arrives on the run worktree.
      handle.syncBack = async () => {
        synced.push(options.cwd);
        git(options.cwd, "commit", "--quiet", "--allow-empty", "-m", "sandbox work");
      };
      return handle;
    };
    ({ runner } = makeRunner(ctx, [adapter]));
    await runner.boot();
    control = await listenControl(runner, runnerSocket(ctx.env));
    const started = await startRun(ctx.cfg, "ship", "Ship it", ctx.env);
    await until(() => runStatus(ctx.cfg, started.id).status === "done", "finished handoff");
    const worktree = path.join(ctx.root, ".claude", "worktrees", `team-${started.id}`);
    assert.match(adapter.calls.find((call) => call.op === "send").text, new RegExp(`team/${started.id} under the team's landing policy.*LAND_FINISH \\{"proof"`));
    assert.deepEqual(synced, [worktree]);
    assert.equal(git(origin, "rev-parse", `refs/heads/team/${started.id}`), git(worktree, "rev-parse", "HEAD"));
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "sandbox work");
    assert.throws(() => git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/main"), "main is never pushed");
  } finally {
    await control?.close();
    await runner?.stop();
    await fake.close();
    rmSync(ctx.home, { recursive: true, force: true });
  }
});
