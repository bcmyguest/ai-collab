#!/usr/bin/env node
// Fake openshell for runner-adapter-cursor tests: sandboxes live in FAKE_OPENSHELL_STATE (JSON); `exec` runs its command locally.
// cursor-agent inside a sandbox maps to FAKE_SANDBOX_CURSOR_BIN. Every argv is appended to FAKE_OPENSHELL_LOG.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write(`${JSON.stringify({ next_page_token: "", sandboxes: load().sandboxes })}\n`);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "create") {
  const state = load();
  state.sandboxes.push({ name: nameArg(args), phase: "ready" });
  save(state);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "start") {
  const state = load();
  for (const s of state.sandboxes) if (s.name === args[2]) s.phase = "ready";
  save(state);
  process.exit(0);
}
if (args[0] === "sandbox" && args[1] === "exec") {
  const cmd = args.slice(args.indexOf("--") + 1);
  if (cmd[0] === "cursor-agent") cmd[0] = process.env.FAKE_SANDBOX_CURSOR_BIN;
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  process.stderr.write(`fake openshell: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
