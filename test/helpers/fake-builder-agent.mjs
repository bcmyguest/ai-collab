#!/usr/bin/env node
// Fake sandboxed builder agent: edits, commits, fires the capture hook and records `ai-collab task set`, per FAKE_BUILDER_MODE.
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
const mode = process.env.FAKE_BUILDER_MODE || "commit";
// The fake openshell maps /sandbox/ to a host directory; HOME is <that>/home.
const sandbox = dirname(process.env.HOME);
if (process.env.FAKE_BUILDER_LOG) appendFileSync(process.env.FAKE_BUILDER_LOG, `${JSON.stringify({ args, cwd: process.cwd(), path: process.env.PATH, gitExec: process.env.GIT_EXEC_PATH || "" })}\n`);
if (mode === "fail") process.exit(3);
appendFileSync(join(process.cwd(), "notes.md"), "a line from the builder\n");
if (mode === "commit") {
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-q", "-m", "docs: add a line"]);
  const hooks = JSON.parse(readFileSync(join(process.env.HOME, ".cursor", "hooks.json"), "utf8")).hooks;
  const command = hooks.postToolUse[0].command.split("/sandbox/").join(`${sandbox}/`);
  execFileSync("sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "postToolUse", cwd: `/sandbox/work/${basename(process.cwd())}` }) });
  const task = process.env.FAKE_BUILDER_TASK;
  execFileSync(join(sandbox, "tools", "bin", "ai-collab"), ["task", "progress", task, "half way"]);
  execFileSync(join(sandbox, "tools", "bin", "ai-collab"), ["task", "set", task, "status=done"]);
}
process.exit(0);
