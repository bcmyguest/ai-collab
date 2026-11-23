// A "sandbox": true schedule runs its agent through runner/sandbox-run.mjs against the fake openshell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTasks } from "../lib/tasks.mjs";
import { loadSchedules, sandboxRunCommand, SANDBOX_RUN, tickFn } from "../runner/schedules.mjs";
import { maxSandboxes, parseArgs, runSandboxName, sandboxCommand, sandboxRun } from "../runner/sandbox-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();
// The fake Cursor CLI the sandbox runs: commits one file, leaves one loose, records a task call through the shim.
const AGENT = `#!/bin/sh
echo "argv: $*"
echo "inspect=$CURSOR_AGENT_ALLOW_PROCESS_INSPECTION project=$AI_COLLAB_PROJECT"
echo committed > committed.txt && git add committed.txt && git -c user.name=T -c user.email=t@example.invalid commit -q -m "inside"
echo loose > loose.txt
sh "$(dirname "$AI_COLLAB_SANDBOX_OUT")/tools/bin/ai-collab" task progress demo-task "progress from the sandbox"
sh "$(dirname "$AI_COLLAB_SANDBOX_OUT")/tools/bin/ai-collab" builder start --task x || echo "builder refused"
exit 0
`;

function lab({ defaults } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-sched-sbx-"));
  const repo = path.join(home, "repo");
  const tree = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [repo, tree, path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", repo]);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(repo, "README"), "hi\n");
  git(repo, "add", "README");
  git(repo, "commit", "--quiet", "-m", "init");
  writeFileSync(path.join(tree, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const agent = path.join(home, "fake-cursor-agent");
  writeFileSync(agent, AGENT, { mode: 0o755 });
  const node = path.join(home, "fake-node");
  writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: repo, project: "demo" }]));
  if (defaults) writeFileSync(path.join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify(defaults));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, "data"),
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: tree,
    AI_COLLAB_BUILDER_NODE: node, AI_COLLAB_BUILDER_NODE_MODULES: "none", AI_COLLAB_BUILDER_GIT: "none", AI_COLLAB_BUILDER_GIT_CORE: "none", AI_COLLAB_BUILDER_ONCEBITTEN: "none",
    FAKE_SANDBOX_CURSOR_BIN: agent, FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
  };
  return { home, repo, env };
}

const sink = () => { let text = ""; return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } }; };
const calls = (env) => readFileSync(env.FAKE_OPENSHELL_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("argv parsing, the command mapping, the sandbox name and the cap", () => {
  assert.deepEqual(parseArgs(["--name", "pm", "--cwd", "/r", "--", "cursor-agent", "-p", "x"]), { name: "pm", cwd: "/r", command: ["cursor-agent", "-p", "x"] });
  assert.throws(() => parseArgs(["--name", "pm", "--", "x"]), /--cwd are required/);
  assert.deepEqual(sandboxCommand(["/home/b/.local/bin/cursor-agent", "-p", "--force", "tick"]), ["cursor-agent", "-p", "--force", "tick"]);
  assert.throws(() => sandboxCommand(["/home/b/steward.sh"]), /runs an agent harness/);
  assert.match(runSandboxName("rule-steward", 0), /^s-rule-ste-[0-9a-f]{6}$/);
  assert.ok(runSandboxName("a-very-long-schedule-name").length <= 19);
  assert.equal(maxSandboxes({ XDG_CONFIG_HOME: "/nonexistent" }), 8);
});

test("a sandboxed run lands commits and loose edits on a new branch, replays task progress, and deletes its sandbox", async () => {
  const l = lab();
  await openTasks("demo", l.env).add({ id: "demo-task", title: "Demo" });
  const out = sink();
  const err = sink();
  const before = git(l.repo, "rev-parse", "HEAD");
  const code = await sandboxRun({ name: "pm", cwd: l.repo, command: ["cursor-agent", "-p", "--force", "tick"] }, { env: l.env, stdout: out, stderr: err, log: (line) => err.write(line + "\n") });
  assert.equal(code, 0, err.text);
  assert.match(out.text, /argv: -p --force tick/);
  assert.match(out.text, /inspect=1 project=demo/);
  assert.match(out.text, /builder refused/);
  assert.equal(git(l.repo, "rev-parse", "HEAD"), before, "the checked-out branch is untouched");
  const branch = git(l.repo, "branch", "--list", "sandbox/pm-*", "--format=%(refname:short)");
  assert.match(branch, /^sandbox\/pm-\d{8}T\d{6}Z$/);
  assert.equal(git(l.repo, "rev-list", "--count", `main..${branch}`), "2");
  assert.equal(git(l.repo, "show", `${branch}:loose.txt`), "loose");
  assert.equal(openTasks("demo", l.env).get("demo-task").progress.at(-1).text, "progress from the sandbox");
  assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
  const create = calls(l.env).find((c) => c[1] === "create");
  assert.ok(create.includes("--policy"));
  const home = calls(l.env).find((c) => c[1] === "upload" && String(c[3]).endsWith("/home/"));
  assert.ok(home, "the sandbox home is uploaded");
});

test("the cap refuses a run when that many sandboxes exist already", async () => {
  const l = lab({ defaults: { maxSandboxes: 1 } });
  writeFileSync(l.env.FAKE_OPENSHELL_STATE, JSON.stringify({ sandboxes: [{ name: "b-other-123456", phase: "Ready" }] }));
  await assert.rejects(sandboxRun({ name: "pm", cwd: l.repo, command: ["cursor-agent", "-p", "x"] }, { env: l.env, log() {} }), /1 OpenShell sandboxes are running, the cap is 1/);
});

test("schedules.json sandbox: validated, wrapped in the sandbox runner, and exempt from the host guard", async () => {
  const l = lab();
  const file = path.join(l.home, "schedules.json");
  writeFileSync(file, JSON.stringify([
    { name: "pm", everyMinutes: 30, cwd: l.repo, command: ["cursor-agent", "-p", "--force", "tick"], sandbox: true },
    { name: "script", everyMinutes: 30, cwd: l.repo, command: ["/bin/true"], sandbox: true },
    { name: "flag", everyMinutes: 30, cwd: l.repo, command: ["cursor-agent"], sandbox: "yes" },
  ]));
  const { entries, errors } = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.deepEqual(entries.map((e) => [e.name, e.sandbox]), [["pm", true]]);
  assert.match(errors[0], /sandbox: true needs a command that runs claude/);
  assert.match(errors[1], /sandbox must be true or false/);
  assert.deepEqual(sandboxRunCommand(entries[0], entries[0].command, "demo"), [process.execPath, SANDBOX_RUN, "--name", "pm", "--cwd", l.repo, "--project", "demo", "--", "cursor-agent", "-p", "--force", "tick"]);
  const result = await tickFn({ ...entries[0], timeoutMs: 60_000 }, { env: { ...l.env, AI_COLLAB_SCOPE: "off" }, projects: [] })(new Date(0), new Date(0), { step: (_name, run) => run() });
  assert.equal(result.ok, true, result.tail);
  assert.match(result.tail, /sandbox s-pm-[0-9a-f]{6} deleted/);
  assert.ok(existsSync(path.join(l.repo, ".git")));
});
