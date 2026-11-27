import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_CHECKOUT } from "../lib/merge-cli.mjs";
import { LandRefused, autoDeployEntry, checkState, deployHost, listOpenPrs, mergePr, requestLand, restartServices, startDeploy } from "../lib/land.mjs";
import { deploy, land } from "../lib/land-cli.ts";
import { autoDeployEnabled } from "../lib/config.mjs";
import { runCli } from "../lib/cli.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom\n", status = 1) => ({ status, stdout: "", stderr });

// A fake run that records every call; answer(file, argv) returns the result.
function fakeRun(answer = () => ok()) {
  const calls = [];
  const run = async (file, argv, options = {}) => {
    calls.push({ file, argv, options });
    return answer(file, argv, options);
  };
  run.calls = calls;
  return run;
}

const ghCall = (run, sub) => run.calls.filter((c) => c.file === "gh" && c.argv[0] === "pr" && c.argv[1] === sub);

const CHECK = (conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", status, conclusion });

test("checkState is success only when every check succeeded", () => {
  assert.equal(checkState([]), "none");
  assert.equal(checkState([CHECK("SUCCESS"), CHECK("SUCCESS")]), "success");
  assert.equal(checkState([CHECK("SUCCESS"), CHECK("FAILURE")]), "failure");
  assert.equal(checkState([CHECK("SUCCESS"), CHECK("", "IN_PROGRESS")]), "pending");
  assert.equal(checkState([CHECK("SKIPPED")]), "failure");
  assert.equal(checkState([{ __typename: "StatusContext", state: "SUCCESS" }]), "success");
  assert.equal(checkState([{ __typename: "StatusContext", state: "PENDING" }]), "pending");
});

test("listOpenPrs asks gh for the PR fields and maps the check state", async () => {
  const run = fakeRun(() => ok(JSON.stringify([{
    number: 7, title: "Land", url: "https://github.com/o/r/pull/7", headRefName: "feat/land",
    headRefOid: SHA, additions: 12, deletions: 3, statusCheckRollup: [CHECK("SUCCESS")],
  }])));
  const prs = await listOpenPrs({ run, cwd: "/host" });
  assert.deepEqual(prs, [{
    number: 7, title: "Land", url: "https://github.com/o/r/pull/7", branch: "feat/land",
    headSha: SHA, additions: 12, deletions: 3, checks: "success",
  }]);
  const list = run.calls[0];
  assert.equal(list.file, "gh");
  assert.deepEqual(list.argv.slice(0, 2), ["pr", "list"]);
  assert.equal(list.argv[list.argv.indexOf("--json") + 1],
    "number,title,url,headRefName,headRefOid,additions,deletions,statusCheckRollup");
});

test("land request pushes the branch and opens a PR into main", async () => {
  const run = fakeRun((file, argv) => {
    if (argv[1] === "list") return ok("[]");
    if (argv[1] === "create") return ok("https://github.com/o/r/pull/8\n");
    return ok();
  });
  const result = await requestLand("feat/remote-land", { run, cwd: "/work" });
  assert.deepEqual(result, { url: "https://github.com/o/r/pull/8", created: true });
  assert.deepEqual(run.calls[0], { file: "git", argv: ["push", "origin", "refs/heads/feat/remote-land:refs/heads/feat/remote-land"], options: run.calls[0].options });
  assert.deepEqual(ghCall(run, "create")[0].argv, ["pr", "create", "--base", "main", "--head", "feat/remote-land", "--fill"]);
});

test("land request reuses the open PR for the branch", async () => {
  const run = fakeRun((file, argv) => (argv[1] === "list" ? ok(JSON.stringify([{ url: "https://github.com/o/r/pull/3" }])) : ok()));
  assert.deepEqual(await requestLand("feat/x", { run, cwd: "/work" }), { url: "https://github.com/o/r/pull/3", created: false });
  assert.equal(ghCall(run, "create").length, 0);
});

test("land request never pushes main", async () => {
  const run = fakeRun();
  await assert.rejects(requestLand("main", { run, cwd: "/work" }), /main/);
  assert.equal(run.calls.length, 0);
});

for (const [label, rollup] of [
  ["failing", [CHECK("FAILURE")]],
  ["pending", [CHECK("", "IN_PROGRESS")]],
  ["unreported", []],
]) {
  test(`merge refuses a PR with ${label} checks`, async () => {
    const run = fakeRun((file, argv) => (argv[1] === "view" ? ok(JSON.stringify({ state: "OPEN", headRefOid: SHA, statusCheckRollup: rollup })) : ok()));
    await assert.rejects(mergePr(7, SHA, { run, cwd: "/host" }), LandRefused);
    assert.equal(ghCall(run, "merge").length, 0);
  });
}

test("merge refuses a head commit that moved after the operator looked", async () => {
  const run = fakeRun((file, argv) => (argv[1] === "view" ? ok(JSON.stringify({ state: "OPEN", headRefOid: OTHER, statusCheckRollup: [CHECK("SUCCESS")] })) : ok()));
  await assert.rejects(mergePr(7, SHA, { run, cwd: "/host" }), /moved/);
  assert.equal(ghCall(run, "merge").length, 0);
});

test("merge with green checks passes --match-head-commit", async () => {
  const run = fakeRun((file, argv) => (argv[1] === "view" ? ok(JSON.stringify({ state: "OPEN", headRefOid: SHA, statusCheckRollup: [CHECK("SUCCESS")] })) : ok()));
  assert.deepEqual(await mergePr(7, SHA, { run, cwd: "/host" }), { merged: true, number: 7 });
  assert.deepEqual(ghCall(run, "merge")[0].argv, ["pr", "merge", "7", "--merge", "--match-head-commit", SHA]);
});

// A host checkout whose HEAD moves to NEW on a successful pull.
function hostRun({ branch = "main", dirty = "", pull = ok(), npm = ok(), systemd = ok(), originMain = NEW, head = OLD } = {}) {
  let current = head;
  return fakeRun((file, argv) => {
    if (file === "systemd-run") return systemd;
    if (file === "npm") return npm;
    if (argv[0] === "symbolic-ref") return ok(`${branch}\n`);
    if (argv[0] === "status") return ok(dirty);
    if (argv[0] === "pull") {
      if (pull.status === 0) current = originMain;
      return pull;
    }
    if (argv[0] === "rev-parse" && argv[1] === "HEAD") return ok(`${current}\n`);
    if (argv[0] === "rev-parse") return ok(`${originMain}\n`);
    return ok();
  });
}

const deployCalls = (run) => run.calls.filter((c) => c.file === "npm");

test("deploy refuses a dirty checkout before pulling", async () => {
  const run = hostRun({ dirty: " M lib/x.mjs\n" });
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"] });
  assert.equal(result.status, "skipped");
  assert.match(result.line, /^skipped: .*local changes/);
  assert.equal(run.calls.some((c) => c.argv[0] === "pull"), false);
  assert.equal(deployCalls(run).length, 0);
});

test("deploy refuses a checkout that is not on main", async () => {
  const run = hostRun({ branch: "feat/x" });
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"] });
  assert.equal(result.status, "skipped");
  assert.match(result.line, /not on main/);
  assert.equal(run.calls.some((c) => c.argv[0] === "pull"), false);
});

test("deploy skips when the pull leaves HEAD where it was", async () => {
  const run = hostRun({ head: OLD, originMain: OLD });
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"] });
  assert.equal(result.status, "skipped");
  assert.match(result.line, /HEAD unchanged/);
  assert.equal(deployCalls(run).length, 0);
});

test("auto deploy does nothing when origin/main equals HEAD", async () => {
  const run = hostRun({ head: OLD, originMain: OLD });
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"], ifMoved: true });
  assert.equal(result.status, "unchanged");
  assert.equal(run.calls.some((c) => c.argv[0] === "pull"), false);
});

test("deploy installs dev dependencies, runs the existing UI deploy step, and reports the range", async () => {
  const run = hostRun();
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"] });
  assert.equal(result.status, "deployed");
  assert.equal(result.line, `deployed ${OLD.slice(0, 12)}..${NEW.slice(0, 12)}`);
  assert.deepEqual(deployCalls(run).map((c) => c.argv), [
    ["ci", "--include=dev"],
    ["run", "build", "--", "--deploy-and-verify"],
  ]);
  assert.equal(run.calls.find((c) => c.argv[0] === "pull").options.cwd, "/host");
});

test("deploy reports a failed npm ci and does not run the build", async () => {
  const run = hostRun({ npm: fail("registry down\n") });
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"] });
  assert.equal(result.status, "failed");
  assert.match(result.line, /^failed: npm ci/);
  assert.equal(deployCalls(run).length, 1);
});

test("restart runs as its own transient unit through systemd-run", async () => {
  const run = fakeRun();
  assert.equal((await restartServices({ run })).status, 0);
  const [call] = run.calls;
  assert.equal(call.file, "systemd-run");
  assert.deepEqual(call.argv.slice(0, 2), ["--user", "--collect"]);
  assert.match(call.argv[2], /^--unit=ai-collab-restart-/);
  assert.deepEqual(call.argv.slice(3), ["systemctl", "--user", "restart", "ai-collab-bus", "ai-collab-ui", "ai-collab-runner"]);
});

test("the UI starts deploy detached through systemd-run", async () => {
  const run = fakeRun();
  await startDeploy({ run, nodePath: "/usr/bin/node", hostCheckout: "/host" });
  const [call] = run.calls;
  assert.equal(call.file, "systemd-run");
  assert.deepEqual(call.argv.slice(0, 2), ["--user", "--collect"]);
  assert.match(call.argv[2], /^--unit=ai-collab-deploy-/);
  assert.deepEqual(call.argv.slice(3), ["/usr/bin/node", "/host/scripts/ai-collab.mjs", "deploy"]);
});

test("the auto-deploy schedule runs deploy --if-moved every 5 minutes", () => {
  const entry = autoDeployEntry({ nodePath: "/usr/bin/node", hostCheckout: HOST_CHECKOUT });
  assert.equal(entry.name, "auto-deploy");
  assert.equal(entry.everyMs, 5 * 60_000);
  assert.equal(entry.cwd, HOST_CHECKOUT);
  assert.deepEqual(entry.command, ["/usr/bin/node", join(HOST_CHECKOUT, "scripts/ai-collab.mjs"), "deploy", "--if-moved"]);
  // A full npm ci and build take minutes; a kill mid-install breaks node_modules, so the timeout is 20 minutes.
  assert.equal(entry.timeoutMs, 20 * 60_000);
});

test("autoDeploy is off unless the env or defaults.json turns it on", (t) => {
  const xdg = tempDir(t, "land-config-");
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: xdg, HOME: xdg };
  assert.equal(autoDeployEnabled(env), false);
  assert.equal(autoDeployEnabled({ ...env, AI_COLLAB_AUTO_DEPLOY: "1" }), true);
  assert.equal(autoDeployEnabled({ ...env, AI_COLLAB_AUTO_DEPLOY: "0" }), false);
  mkdirSync(join(xdg, "ai-collab"), { recursive: true });
  writeFileSync(join(xdg, "ai-collab", "defaults.json"), JSON.stringify({ autoDeploy: true }));
  assert.equal(autoDeployEnabled(env), true);
  assert.equal(autoDeployEnabled({ ...env, AI_COLLAB_AUTO_DEPLOY: "0" }), false);
});

test("the CLI exposes land and deploy and dispatches land request", async () => {
  let output = "";
  const out = { write: (message) => { output += message; } };
  assert.equal(await runCli(["land", "--help"], { stdout: out, stderr: out }), 0);
  assert.match(output, /land request <branch>/);
  output = "";
  assert.equal(await runCli(["deploy", "--help"], { stdout: out, stderr: out }), 0);
  assert.match(output, /deploy/);
});

test("land request CLI prints the PR URL", async () => {
  const run = fakeRun((file, argv) => (argv[1] === "list" ? ok("[]") : argv[1] === "create" ? ok("https://github.com/o/r/pull/9\n") : ok()));
  let output = "";
  const status = await land(["request", "feat/cli"], { env: {}, out: { write: (m) => { output += m; } }, err: { write: () => {} }, run, cwd: "/work" });
  assert.equal(status, 0);
  assert.equal(output, "https://github.com/o/r/pull/9\n");
});

test("deploy CLI publishes the line, records it, then restarts", async (t) => {
  const stateDir = tempDir(t, "land-state-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const run = hostRun();
  const published = [];
  const env = { AI_COLLAB_STATE_DIR: stateDir };
  let output = "";
  const status = await deploy([], {
    env, run, hostCheckout: "/host", npm: ["npm"], nodePath: "/usr/bin/node",
    out: { write: (m) => { output += m; } }, err: { write: () => {} },
    publish: async (line) => { published.push(line); assert.equal(run.calls.some((c) => c.file === "systemd-run"), false); },
  });
  assert.equal(status, 0);
  assert.equal(output, `deployed ${OLD.slice(0, 12)}..${NEW.slice(0, 12)}\n`);
  assert.deepEqual(published, [`deployed ${OLD.slice(0, 12)}..${NEW.slice(0, 12)}`]);
  assert.equal(run.calls.at(-1).file, "systemd-run");
  const last = JSON.parse(readFileSync(join(stateDir, "deploy-last.json"), "utf8"));
  assert.equal(last.line, published[0]);
  assert.equal(existsSync(join(stateDir, "deploy.lock")), false);
});

test("deploy CLI refuses to run beside another deploy", async (t) => {
  const stateDir = tempDir(t, "land-state-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(join(stateDir, "deploy.lock"));
  const run = hostRun();
  let output = "";
  const status = await deploy([], {
    env: { AI_COLLAB_STATE_DIR: stateDir }, run, hostCheckout: "/host", npm: ["npm"],
    out: { write: (m) => { output += m; } }, err: { write: () => {} }, publish: async () => {},
  });
  assert.equal(status, 0);
  assert.equal(output, "skipped: another deploy is running\n");
  assert.equal(run.calls.length, 0);
});

test("a deploy lock owned by a live pid still blocks", async (t) => {
  const stateDir = tempDir(t, "land-state-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const lock = join(stateDir, "deploy.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
  const run = hostRun();
  let output = "";
  await deploy([], {
    env: { AI_COLLAB_STATE_DIR: stateDir }, run, hostCheckout: "/host", npm: ["npm"],
    out: { write: (m) => { output += m; } }, err: { write: () => {} }, publish: async () => {},
  });
  assert.equal(output, "skipped: another deploy is running\n");
  assert.equal(run.calls.length, 0);
});

test("a deploy lock left by a dead pid is taken over", async (t) => {
  const stateDir = tempDir(t, "land-state-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // A child that has exited: its pid is gone.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const lock = join(stateDir, "deploy.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: dead, host: hostname() }));
  const run = hostRun();
  let output = "";
  const status = await deploy([], {
    env: { AI_COLLAB_STATE_DIR: stateDir }, run, hostCheckout: "/host", npm: ["npm"],
    out: { write: (m) => { output += m; } }, err: { write: () => {} }, publish: async () => {},
  });
  assert.equal(status, 0);
  assert.equal(output, `deployed ${OLD.slice(0, 12)}..${NEW.slice(0, 12)}\n`);
  assert.equal(existsSync(lock), false);
});

test("deploy publishes a skipped line only when its reason changes", async (t) => {
  const stateDir = tempDir(t, "land-state-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const published = [];
  const common = {
    env: { AI_COLLAB_STATE_DIR: stateDir }, hostCheckout: "/host", npm: ["npm"],
    out: { write: () => {} }, err: { write: () => {} },
    publish: async (line) => { published.push(line); },
  };
  const dirty = () => hostRun({ dirty: " M lib/x.mjs\n" });
  await deploy([], { ...common, run: dirty() });
  await deploy([], { ...common, run: dirty() });
  assert.deepEqual(published, ["skipped: the host checkout has local changes"]);
  await deploy([], { ...common, run: hostRun({ branch: "feat/x" }) });
  assert.deepEqual(published, [
    "skipped: the host checkout has local changes",
    "skipped: the host checkout is on feat/x, not on main",
  ]);
});
