// `ai-collab deploy --from <worktree|branch>` and `--main`: the units run through one link, and auto deploy holds while another tree is live.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DROP_IN, deployLink, installUnits, unitDropIn } from "../lib/deploy-tree.mjs";
import { deploy } from "../lib/land-cli.ts";
import { tempDir } from "./helpers/tmp.mjs";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const BRANCH_SHA = "3".repeat(40);
const SERVICES = ["ai-collab-bus", "ai-collab-ui", "ai-collab-runner"];
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const workflows = (version) => `export const DBOS_APP_VERSION = "${version}";\n`;

// A host checkout, a state dir, a cache dir and a systemd units dir, all under one temp root.
function fixture(t, { units = true } = {}) {
  const root = realpathSync(tempDir(t, "deploy-any-tree-"));
  const host = join(root, "host");
  const env = {
    HOME: root, AI_COLLAB_STATE_DIR: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"), AI_COLLAB_RUNNER_SOCKET: join(root, "no-runner.sock"),
  };
  mkdirSync(join(host, "lib"), { recursive: true });
  writeFileSync(join(host, "lib", "workflows.ts"), workflows("ai-collab-1"));
  if (units) for (const service of SERVICES) {
    mkdirSync(join(root, "config", "systemd", "user", `${service}.service.d`), { recursive: true });
    writeFileSync(join(root, "config", "systemd", "user", `${service}.service.d`, DROP_IN), "[Service]\n");
  }
  return { root, host, env };
}

// Fake git, npm, systemctl and node. Branch worktrees appear on `git worktree add`; the host pulls OLD to NEW.
function fakeRun({ host, head = OLD, pulled = NEW, branches = { "feat/x": BRANCH_SHA }, dirtyTrees = [], npmStatus = 0 } = {}) {
  const calls = [];
  let current = head;
  const run = async (file, argv, options = {}) => {
    calls.push({ file, argv, cwd: options.cwd });
    if (file !== "git") return file === "npm" ? { status: npmStatus, stdout: "", stderr: "" } : ok();
    const [cmd, ...rest] = argv;
    if (cmd === "check-ref-format") return /\.\.|^-|\s|[~^:?*[\\]|@\{/.test(rest.at(-1)) ? { status: 1, stdout: "", stderr: "" } : ok();
    if (cmd === "symbolic-ref") return ok(options.cwd === host ? "main\n" : "feat/path\n");
    if (cmd === "status") return ok(dirtyTrees.includes(options.cwd) ? " M lib/x.mjs\n" : "");
    if (cmd === "pull") { current = pulled; return ok(); }
    if (cmd === "worktree" && rest[0] === "add") {
      const tree = rest.at(-2);
      mkdirSync(join(tree, "lib"), { recursive: true });
      writeFileSync(join(tree, "lib", "workflows.ts"), workflows(branchVersion));
      return ok();
    }
    if (cmd === "rev-parse") {
      if (rest[0] === "--show-toplevel") return ok(`${options.cwd}\n`);
      const ref = rest.at(-1);
      const branch = Object.keys(branches).find((name) => ref.includes(`/${name}^`));
      if (branch) return ok(`${branches[branch]}\n`);
      if (ref.startsWith("refs/")) return { status: 1, stdout: "", stderr: "unknown ref\n" };
      return ok(`${options.cwd === host ? current : BRANCH_SHA}\n`);
    }
    return ok();
  };
  let branchVersion = "ai-collab-1";
  run.calls = calls;
  run.branchVersion = (version) => { branchVersion = version; };
  return run;
}

async function runDeploy(args, { env, host, run, inflight = async () => [], cwd }) {
  let output = "";
  const published = [];
  const status = await deploy(args, {
    env, run, hostCheckout: host, npm: ["npm"], nodePath: "/usr/bin/node", inflight, ...(cwd ? { cwd } : {}),
    out: { write: (m) => { output += m; } }, err: { write: (m) => { output += m; } },
    publish: async (line) => { published.push(line); },
  });
  return { status, output, published };
}

const last = (env) => JSON.parse(readFileSync(join(env.AI_COLLAB_STATE_DIR, "deploy-last.json"), "utf8"));
const uiRestarts = (run) => run.calls.filter((c) => c.file === "systemctl" && c.argv.includes("restart") && c.argv.includes("ai-collab-ui.service"));
const transient = (run) => run.calls.filter((c) => c.file === "systemd-run");

test("the drop-in sends ExecStart and WorkingDirectory through the link, in either spelling of the checkout", () => {
  const unitText = `[Unit]\nDescription=UI\n\n[Service]\nWorkingDirectory=%h/ai-collab\nExecStart=/usr/bin/node %h/ai-collab/node_modules/next/dist/bin/next start /home/b/ai-collab/web -p 8795\n`;
  const text = unitDropIn({ unitText, dropIns: [], hostCheckout: "/home/b/ai-collab", home: "/home/b", link: "/s/current" });
  assert.match(text, /^WorkingDirectory=\/s\/current$/m);
  assert.match(text, /^ExecStart=$/m);
  assert.match(text, /^ExecStart=\/usr\/bin\/node \/s\/current\/node_modules\/next\/dist\/bin\/next start \/s\/current\/web -p 8795$/m);
});

test("the drop-in honours a later ExecStart override and leaves a sibling path alone", () => {
  const unitText = "[Service]\nExecStart=/usr/bin/node /home/b/ai-collab/old.mjs\n";
  const dropIns = ["[Service]\nExecStart=\nExecStart=/usr/bin/node /home/b/ai-collab/scripts/ai-collab-bus.mjs /home/b/ai-collab-data\n"];
  const text = unitDropIn({ unitText, dropIns, hostCheckout: "/home/b/ai-collab", home: "/home/b", link: "/s/current" });
  assert.match(text, /^ExecStart=\/usr\/bin\/node \/s\/current\/scripts\/ai-collab-bus\.mjs \/home\/b\/ai-collab-data$/m);
  assert.throws(() => unitDropIn({ unitText: "[Service]\nExecStart=/usr/bin/true\n", dropIns: [], hostCheckout: "/home/b/ai-collab", home: "/home/b", link: "/s/current" }), /host checkout/);
});

test("--install-units writes one drop-in per unit, points the link at the host checkout, and reloads systemd", async (t) => {
  const { root, host, env } = fixture(t, { units: false });
  const dir = join(root, "config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  for (const service of SERVICES) writeFileSync(join(dir, `${service}.service`), `[Service]\nExecStart=/usr/bin/node ${host}/scripts/${service}.mjs\n`);
  const run = fakeRun({ host });
  const written = await installUnits({ env, hostCheckout: host, run, services: SERVICES });
  assert.equal(written.length, 3);
  for (const service of SERVICES) assert.match(readFileSync(join(dir, `${service}.service.d`, DROP_IN), "utf8"), new RegExp(`ExecStart=/usr/bin/node ${deployLink(env)}/scripts/${service}.mjs`));
  assert.equal(readlinkSync(deployLink(env)), host);
  assert.deepEqual(run.calls.map((c) => [c.file, ...c.argv]), [["systemctl", "--user", "daemon-reload"]]);
});

test("--from refuses until the units run through the link", async (t) => {
  const { host, env } = fixture(t, { units: false });
  const run = fakeRun({ host });
  const result = await runDeploy(["--from", "feat/x"], { env, host, run });
  assert.equal(result.status, 1);
  assert.match(result.output, /--install-units/);
  assert.equal(run.calls.length, 0);
});

test("--from <branch> checks it out under the deploy cache, builds, verifies, restarts each service once and records the ref", async (t) => {
  const { root, host, env } = fixture(t);
  const run = fakeRun({ host });
  const result = await runDeploy(["--from", "feat/x"], { env, host, run });
  const tree = join(root, "cache", "ai-collab-deploy", "feat/x");
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output, `deployed feat/x ${BRANCH_SHA.slice(0, 12)}\n`);
  assert.deepEqual(run.calls.find((c) => c.argv[0] === "worktree").argv, ["worktree", "add", "--detach", tree, BRANCH_SHA]);
  assert.deepEqual(run.calls.filter((c) => c.file === "npm").map((c) => [c.cwd, ...c.argv]), [[tree, "ci", "--include=dev"], [tree, "run", "build"]]);
  assert.equal(readlinkSync(deployLink(env)), tree);
  assert.equal(uiRestarts(run).length, 1);
  assert.deepEqual(run.calls.find((c) => c.file === "/usr/bin/node").argv, [join(tree, "deploy", "verify-ui.mjs")]);
  assert.equal(transient(run).length, 1);
  assert.deepEqual(transient(run)[0].argv.slice(3), ["systemctl", "--user", "restart", "ai-collab-bus", "ai-collab-runner"]);
  assert.equal(run.calls.at(-1).file, "systemd-run");
  assert.deepEqual({ ref: last(env).ref, tree: last(env).tree, sha: last(env).sha }, { ref: "feat/x", tree, sha: BRANCH_SHA });
  assert.deepEqual(result.published, [`deployed feat/x ${BRANCH_SHA.slice(0, 12)}`]);
});

test("--from rejects refs that are not plain branch names before touching a tree", async (t) => {
  const { host, env } = fixture(t);
  for (const bad of ["main", "-x", "a..b", "$(touch x)", "a b", "~/x"]) {
    const run = fakeRun({ host });
    const result = await runDeploy([`--from=${bad}`], { env, host, run });
    assert.notEqual(result.status, 0, bad);
    assert.match(result.output, /^failed: .*(not a valid branch name|use --main)/, bad);
    assert.equal(run.calls.some((c) => ["worktree", "checkout", "fetch"].includes(c.argv[0]) || c.file === "npm"), false, bad);
  }
});

test("--from <path> refuses a dirty tree unless --allow-dirty", async (t) => {
  const { root, host, env } = fixture(t);
  const tree = join(root, "wt");
  mkdirSync(join(tree, "lib"), { recursive: true });
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "ai-collab" }));
  writeFileSync(join(tree, "lib", "workflows.ts"), workflows("ai-collab-1"));
  const dirty = await runDeploy(["--from", tree], { env, host, run: fakeRun({ host, dirtyTrees: [tree] }) });
  assert.match(dirty.output, /local changes; --allow-dirty/);
  assert.equal(existsSync(deployLink(env)), false);
  const allowed = await runDeploy(["--from", tree, "--allow-dirty"], { env, host, run: fakeRun({ host, dirtyTrees: [tree] }) });
  assert.equal(allowed.status, 0, allowed.output);
  assert.equal(readlinkSync(deployLink(env)), tree);
  assert.equal(last(env).ref, "feat/path");
});

test("--from <path> rejects a directory that is not an ai-collab checkout", async (t) => {
  const { root, host, env } = fixture(t);
  const tree = join(root, "other");
  mkdirSync(tree);
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "other" }));
  const result = await runDeploy(["--from", tree], { env, host, run: fakeRun({ host }) });
  assert.equal(result.status, 1);
  assert.match(result.output, /not an ai-collab checkout/);
});

test("while a branch is deployed, auto deploy does nothing and a plain deploy says how to return", async (t) => {
  const { host, env } = fixture(t);
  await runDeploy(["--from", "feat/x"], { env, host, run: fakeRun({ host }) });
  const auto = fakeRun({ host });
  const held = await runDeploy(["--if-moved"], { env, host, run: auto });
  assert.equal(held.status, 0);
  assert.equal(held.output, "");
  assert.equal(auto.calls.length, 0);
  const plain = fakeRun({ host });
  const skipped = await runDeploy([], { env, host, run: plain });
  assert.match(skipped.output, /^skipped: feat\/x is deployed; run ai-collab deploy --main/);
  assert.equal(plain.calls.some((c) => c.argv[0] === "pull"), false);
  assert.equal(last(env).ref, "feat/x");
});

test("--main points the link back at the host checkout without a rebuild when main has not moved", async (t) => {
  const { host, env } = fixture(t);
  const first = await runDeploy([], { env, host, run: fakeRun({ host }) });
  assert.equal(first.status, 0, first.output);
  assert.equal(last(env).deployed, NEW);
  await runDeploy(["--from", "feat/x"], { env, host, run: fakeRun({ host }) });
  const back = fakeRun({ host, head: NEW, pulled: NEW });
  const result = await runDeploy(["--main"], { env, host, run: back });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output, `deployed main ${NEW.slice(0, 12)}\n`);
  assert.equal(back.calls.some((c) => c.file === "npm"), false);
  assert.equal(readlinkSync(deployLink(env)), host);
  assert.equal(last(env).ref, "main");
  assert.equal(uiRestarts(back).length, 1);
});

test("a main deploy builds without --deploy-and-verify and restarts the UI once", async (t) => {
  const { host, env } = fixture(t);
  const run = fakeRun({ host });
  const result = await runDeploy([], { env, host, run });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(run.calls.filter((c) => c.file === "npm").map((c) => c.argv), [["ci", "--include=dev"], ["run", "build"]]);
  assert.equal(uiRestarts(run).length, 1);
  assert.deepEqual(transient(run)[0].argv.slice(3), ["systemctl", "--user", "restart", "ai-collab-bus", "ai-collab-runner"]);
});

test("in-flight runner turns hold the restart until --force", async (t) => {
  const { host, env } = fixture(t);
  const inflight = async () => ["claude#a", "codex#b"];
  const run = fakeRun({ host });
  const held = await runDeploy(["--from", "feat/x"], { env, host, run, inflight });
  assert.match(held.output, /^skipped: 2 runner turn\(s\) in flight \(claude#a, codex#b\); --force restarts anyway/);
  assert.equal(run.calls.some((c) => c.file === "npm" || c.file === "systemctl" || c.file === "systemd-run"), false);
  const forced = await runDeploy(["--from", "feat/x", "--force"], { env, host, run: fakeRun({ host }), inflight });
  assert.equal(forced.status, 0, forced.output);
});

test("a DBOS app-version change holds the restart until --force", async (t) => {
  const { host, env } = fixture(t);
  const run = fakeRun({ host });
  run.branchVersion("ai-collab-2");
  const held = await runDeploy(["--from", "feat/x"], { env, host, run });
  assert.match(held.output, /DBOS app version changes ai-collab-1 -> ai-collab-2/);
  assert.equal(existsSync(deployLink(env)), false);
  const forced = fakeRun({ host });
  forced.branchVersion("ai-collab-2");
  assert.equal((await runDeploy(["--from", "feat/x", "--force"], { env, host, run: forced })).status, 0);
});

test("a deployed path is read back through the link as the running tree", async (t) => {
  const { root, host, env } = fixture(t);
  const tree = join(root, "running");
  mkdirSync(join(tree, "lib"), { recursive: true });
  writeFileSync(join(tree, "lib", "workflows.ts"), workflows("ai-collab-0"));
  mkdirSync(env.AI_COLLAB_STATE_DIR, { recursive: true });
  symlinkSync(tree, deployLink(env));
  const held = await runDeploy(["--main"], { env, host, run: fakeRun({ host }) });
  assert.match(held.output, /DBOS app version changes ai-collab-0 -> ai-collab-1/);
});
