#!/usr/bin/env node
// Fake openshell for runner-adapter-cursor tests: sandboxes live in FAKE_OPENSHELL_STATE (JSON); `exec` runs its
// command locally; upload/download copy real files so a test can see the worktree round trip.
// A sandboxed cursor binary maps to FAKE_SANDBOX_CURSOR_BIN. Every argv is appended to FAKE_OPENSHELL_LOG.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
if (process.env.FAKE_OPENSHELL_LOG) appendFileSync(process.env.FAKE_OPENSHELL_LOG, `${JSON.stringify(args)}\n`);

const statePath = process.env.FAKE_OPENSHELL_STATE;
const load = () => (statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sandboxes: [] });
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const nameArg = (argv) => {
  const i = argv.indexOf("-n") >= 0 ? argv.indexOf("-n") + 1 : argv.indexOf("--name") + 1;
  return argv[i];
};
// Every `--label key=value` on a create, as the sandbox record reports them; a sandbox without labels reports {}.
const labelsOf = (argv) => Object.fromEntries(argv.flatMap((arg, i) => (arg === "--label" ? [argv[i + 1]] : [])).map((pair) => {
  const at = pair.indexOf("=");
  return [pair.slice(0, at), pair.slice(at + 1)];
}));
// The fake sandbox filesystem: a real directory per sandbox, so upload and download move real bytes. It sits
// beside the fake's state file (the test's own temp dir), never in the directory the test runs from.
const root = () => process.env.FAKE_OPENSHELL_ROOT
  || (statePath ? join(dirname(statePath), "sandboxes") : join(tmpdir(), "fake-openshell"));
// One mapping for every command: the sandbox's root directory is /sandbox, and a relative path is from there.
const inside = (sandbox, remote) => {
  const base = join(root(), sandbox);
  const rel = String(remote || "").replace(/^\/sandbox\/?/, "").replace(/^\/+/, "");
  return rel ? join(base, rel) : base;
};

if (args[0] === "sandbox" && args[1] === "list") {
  // With `pageSize` in the state, a page holds that many sandboxes and names the next page's offset as its token.
  const state = load();
  const tokenAt = args.indexOf("--page-token");
  const start = tokenAt >= 0 ? Number(args[tokenAt + 1]) : 0;
  const end = start + (state.pageSize ?? state.sandboxes.length);
  const next = end < state.sandboxes.length ? String(end) : "";
  process.stdout.write(`${JSON.stringify({ next_page_token: next, sandboxes: state.sandboxes.slice(start, end) })}\n`);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "create") {
  const state = load();
  const name = nameArg(args);
  rmSync(inside(name), { recursive: true, force: true });
  state.sandboxes.push({ name, phase: "Ready", labels: labelsOf(args) });
  save(state);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "start") {
  const state = load();
  for (const s of state.sandboxes) if (s.name === args[2]) s.phase = "Ready";
  save(state);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "resume") {
  const state = load();
  for (const s of state.sandboxes) if (s.name === args[2]) s.phase = "Ready";
  save(state);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "delete") {
  const state = load();
  save({ ...state, sandboxes: state.sandboxes.filter((s) => s.name !== args[2]) });
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "upload") {
  const taskSnapshot = process.env.FAKE_OPENSHELL_UPLOAD_TASKS;
  if (taskSnapshot) {
    const snapshot = JSON.parse(readFileSync(taskSnapshot, "utf8"));
    appendFileSync(taskSnapshot + ".uploads", JSON.stringify(snapshot) + "\n");
  }
  const [, , sandbox, local, dest] = args;
  const target = inside(sandbox, dest || ".");
  // A trailing slash on DEST means "put the basename inside it", which is what openshell 0.1.9 does.
  const final = String(dest || "").endsWith("/") || !String(dest || "").split("/").pop().includes(".")
    ? join(target, basename(String(local).replace(/\/+$/, "")))
    : target;
  mkdirSync(dirname(final), { recursive: true });
  // A second upload over the same name replaces it, as openshell does.
  rmSync(final, { recursive: true, force: true });
  cpSync(String(local).replace(/\/+$/, ""), final, { recursive: true });
  process.stdout.write(`✓ Upload complete: ${local} -> ${final}\n`);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "download") {
  const [, , sandbox, remote, dest] = args;
  if (process.env.FAKE_FAIL_RETRY_DOWNLOAD && remote.startsWith("/sandbox/work/")) {
    const calls = readFileSync(process.env.FAKE_OPENSHELL_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    if (calls.filter((call) => call[1] === "create").length === 2) process.exit(1);
  }
  const from = inside(sandbox, remote);
  if (!existsSync(from)) {
    process.stderr.write(`download: ${remote} is not in sandbox ${sandbox}\n`);
    process.exit(1);
  }
  mkdirSync(String(dest || "."), { recursive: true });
  cpSync(from, String(dest || "."), { recursive: true, force: true });
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "exec") {
  const name = nameArg(args);
  const workdirAt = args.indexOf("--workdir");
  const envAt = [...args.keys()].filter((i) => args[i] === "--env").map((i) => args[i + 1]);
  const cmd = args.slice(args.indexOf("--") + 1);
  // Test shim: the adapter speaks the sandbox's real paths (/sandbox/...); map them into this sandbox's directory.
  const mapped = (value) => (root() ? String(value).split("/sandbox/").join(`${join(root(), name)}/`) : String(value));
  for (let i = 0; i < cmd.length; i += 1) cmd[i] = mapped(cmd[i]);
  if (cmd[0] === "cursor-agent" || cmd[0] === "agent") cmd[0] = process.env.FAKE_SANDBOX_CURSOR_BIN;
  if (cmd[0] === "opencode" && process.env.FAKE_SANDBOX_OPENCODE_BIN) cmd[0] = process.env.FAKE_SANDBOX_OPENCODE_BIN;
  const env = { ...process.env };
  // The fake runs the command on the host, so it keeps the host PATH; the sandbox's own PATH would break a shebang.
  for (const pair of envAt) { const [k, ...v] = pair.split("="); if (k !== "PATH") env[k] = mapped(v.join("=")); }
  const cwd = workdirAt >= 0 ? inside(name, args[workdirAt + 1]) : undefined;
  if (process.env.LD_LIBRARY_PATH && env.LD_LIBRARY_PATH !== process.env.LD_LIBRARY_PATH) {
    env.LD_LIBRARY_PATH = [env.LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  if (cwd) mkdirSync(cwd, { recursive: true });
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, ...(cwd ? { cwd } : {}) });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code) => {
    if (process.env.FAKE_BUILDER_CUT_AFTER_AGENT && cmd[0] === process.env.FAKE_SANDBOX_CURSOR_BIN) {
      process.kill(process.ppid, "SIGKILL");
    }
    process.exit(code ?? 1);
  });
} else {
  process.stderr.write(`fake openshell: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
