// Golden record of the sandbox staging and upload per harness, for `ai-collab builder` and runner/sandbox-run.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import { sandboxRun } from "../runner/sandbox-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "golden", "sandbox-staging.json");
const RECORD = process.env.AI_COLLAB_GOLDEN_RECORD === "1";
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
const SYSTEMD = path.join(HERE, "helpers", "fake-systemd-run.mjs");
const AGENT = path.join(HERE, "helpers", "fake-builder-agent.mjs");
const CLAUDE = path.join(HERE, "helpers", "fake-claude-builder.mjs");
const ONCEBITTEN = path.join(HERE, "helpers", "fake-oncebitten.mjs");
for (const f of [OPENSHELL, SYSTEMD, AGENT, CLAUDE, ONCEBITTEN]) chmodSync(f, 0o755);
// The Cursor CLI a sandbox-run schedule executes: commits one file and leaves one loose.
const SCHEDULE_AGENT = `#!/bin/sh
echo committed > committed.txt && git add committed.txt && git -c user.name=T -c user.email=t@example.invalid commit -q -m "inside"
echo loose > loose.txt
exit 0
`;
const SCRIPT = "#!/bin/sh\nexit 0\n";
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const readJsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

// One host: a repo registered as project "demo", a ntfy token, fake openshell, systemd and node, and the harness's install.
function lab(harness) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-golden-"));
  const root = path.join(home, "repo");
  const bin = path.join(home, "bin");
  const cfg = path.join(home, ".config", "ai-collab");
  for (const dir of [root, bin, cfg, path.join(home, ".claude"), path.join(home, ".config", "cursor"), path.join(home, "codex-release", "bin")]) mkdirSync(dir, { recursive: true });
  symlinkSync(SYSTEMD, path.join(bin, "systemd-run"));
  symlinkSync(SYSTEMD, path.join(bin, "systemctl"));
  // Stand-ins on PATH, so a sandboxed run never reaches a real harness on this host.
  for (const f of ["claude", "codex"]) writeFileSync(path.join(bin, f), SCRIPT, { mode: 0o755 });
  const tree = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  mkdirSync(tree, { recursive: true });
  for (const f of ["cursor-agent", "node"]) writeFileSync(path.join(tree, f), SCRIPT, { mode: 0o755 });
  writeFileSync(path.join(home, ".config", "cursor", "auth.json"), '{"token":"golden"}\n', { mode: 0o600 });
  writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"golden"}}\n', { mode: 0o600 });
  writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  writeFileSync(path.join(home, "codex-release", "bin", "codex"), SCRIPT, { mode: 0o755 });
  const claudeBin = path.join(home, "claude-release");
  writeFileSync(claudeBin, SCRIPT, { mode: 0o755 });
  const token = path.join(home, "ntfy-token");
  writeFileSync(token, "golden-ntfy-token\n", { mode: 0o600 });
  writeFileSync(path.join(cfg, "defaults.json"), JSON.stringify({ tokenFile: token }));
  writeFileSync(path.join(cfg, "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const git = (...args) => execFileSync("git", ["-C", root, ...ID, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(root, "notes.md"), "# notes\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const node = path.join(home, "fake-node");
  writeFileSync(node, SCRIPT, { mode: 0o755 });
  const agent = path.join(home, "fake-cursor-agent");
  writeFileSync(agent, SCHEDULE_AGENT, { mode: 0o755 });
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: harness, AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_BUILDER_WORKTREES: home,
    AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: tree, AI_COLLAB_CODEX_TREE: path.join(home, "codex-release"),
    AI_COLLAB_CLAUDE_BIN: claudeBin, AI_COLLAB_ONCEBITTEN_BIN: ONCEBITTEN, AI_COLLAB_BUILDER_NODE: node,
    AI_COLLAB_BUILDER_NODE_MODULES: "none", AI_COLLAB_BUILDER_GIT: "none", AI_COLLAB_BUILDER_GIT_CORE: "none", AI_COLLAB_BUILDER_ONCEBITTEN: "none",
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_SANDBOX_CURSOR_BIN: agent, FAKE_BUILDER_LOG: path.join(home, "agent.log"), FAKE_BUILDER_TASK: "smoke-task",
    FAKE_SYSTEMD_LOG: path.join(home, "systemd.log"), FAKE_SYSTEMD_UNIT_LOG: path.join(home, "unit.log"), FAKE_ONCEBITTEN_LOG: path.join(home, "oncebitten.log"),
  };
  return { home, root, env, git };
}

// The sandbox tree as paths, modes and link targets; the ai-collab copy is recorded by name only.
function walk(dir, rel = "", out = []) {
  for (const name of readdirSync(dir).sort()) {
    const here = path.join(dir, name);
    const next = rel ? `${rel}/${name}` : name;
    if (name === ".git") { out.push([next, "git"]); continue; }
    const st = lstatSync(here);
    if (st.isSymbolicLink()) { out.push([next, "link", readlinkSync(here)]); continue; }
    if (st.isDirectory()) {
      if (next.endsWith("tools/ai-collab")) { out.push([next, "dir", "(app copy)"]); continue; }
      out.push([next, "dir", (st.mode & 0o777).toString(8)]);
      walk(here, next, out);
      continue;
    }
    out.push([next, "file", (st.mode & 0o777).toString(8)]);
  }
  return out;
}

// Drops per-run randomness (temp dirs, schedule hashes, builder ids, stamps) and the lab's home path.
function normalize(value, home) {
  const text = JSON.stringify(value)
    .split(home).join("<HOME>")
    .replace(/(ai-collab-(sandbox-run-auth|builder-auth|sandbox-secret|golden)-|sandbox-run-|download-)[A-Za-z0-9]{6}/g, "$1<R>")
    .replace(/s-pm-[0-9a-f]{6}/g, "s-pm-<H>")
    .replace(/sandbox\/pm-\d{8}T\d{6}Z/g, "sandbox/pm-<STAMP>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
  return JSON.parse(text);
}

function record(l) {
  const argv = readJsonLines(l.env.FAKE_OPENSHELL_LOG);
  const create = argv.find((a) => a[1] === "create");
  const policyFile = create && create.includes("--policy") ? create[create.indexOf("--policy") + 1] : "";
  const policy = policyFile && existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, "utf8")) : null;
  const sandboxes = path.join(l.home, "sandboxes");
  const tree = existsSync(sandboxes) ? readdirSync(sandboxes).sort().map((box) => [box, walk(path.join(sandboxes, box))]) : [];
  const branches = l.git("for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").sort();
  const commits = Object.fromEntries(branches.map((b) => [b, l.git("log", "--format=%s", `main..${b}`).trim().split("\n").filter(Boolean)]));
  return normalize({ openshell: argv, policy, tree, branches: commits }, l.home);
}

const golden = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));
function check(name, value) {
  if (RECORD) {
    golden[name] = value;
    mkdirSync(path.dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
    return;
  }
  assert.deepEqual(value, golden[name], `${name} drifted from the golden record`);
}

const sink = () => { let text = ""; return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } }; };

for (const harness of ["cursor", "claude"]) {
  test(`builder ${harness}: openshell invocations, uploads, modes and landing`, async () => {
    const l = lab(harness);
    const cli = async (...argv) => {
      let out = "";
      let err = "";
      const code = await runCli(argv, { env: l.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
      return { code, out, err };
    };
    assert.equal((await cli("task", "add", "Smoke", "task")).out, "smoke-task\n");
    const brief = path.join(l.home, "brief.md");
    writeFileSync(brief, "Add one line to notes.md.\n");
    const args = ["builder", "start", "--task", "smoke-task", "--harness", harness, "--brief", brief];
    if (harness === "claude") args.push("--model", "claude-haiku-5-5");
    await cli(...args);
    check(`builder-${harness}`, record(l));
  });
}

for (const harness of ["cursor", "claude", "codex"]) {
  test(`sandbox-run ${harness}: openshell invocations, uploads, modes and landing`, async () => {
    const l = lab(harness);
    const command = { cursor: ["cursor-agent", "-p", "x"], claude: ["claude", "-p", "x"], codex: ["codex", "exec", "x"] }[harness];
    const out = sink();
    const err = sink();
    await sandboxRun({ name: "pm", cwd: l.root, command }, { env: l.env, stdout: out, stderr: err, log: (line) => err.write(`${line}\n`) });
    check(`sandbox-run-${harness}`, record(l));
  });
}
