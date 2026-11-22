#!/usr/bin/env node
// Fake sandboxed Claude builder: records its argv, env, settings and MCP config, fires a capture hook, commits, marks the task done.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
const sandbox = dirname(process.env.HOME);
const after = (flag) => args[args.indexOf(flag) + 1];
const settings = JSON.parse(readFileSync(after("--settings"), "utf8"));
const mcp = JSON.parse(readFileSync(after("--mcp-config"), "utf8"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE_|DISABLE_|ENABLE_CLAUDEAI|HOME$)/.test(k)));
appendFileSync(process.env.FAKE_BUILDER_LOG, `${JSON.stringify({ args, env, settings, mcp, cwd: process.cwd() })}\n`);
const hook = settings.hooks.PostToolUse[0].hooks[0].command.split("/sandbox/").join(`${sandbox}/`);
execFileSync("sh", ["-c", hook], { input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: `/sandbox/work/${basename(process.cwd())}` }) });
appendFileSync(join(process.cwd(), "notes.md"), "a line from claude\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-q", "-m", "docs: claude line"]);
if (process.env.FAKE_CLAUDE_REFRESH) writeFileSync(join(process.env.HOME, ".claude", ".credentials.json"), process.env.FAKE_CLAUDE_REFRESH);
if (process.env.FAKE_HOST_CREDS_TOUCH) writeFileSync(process.env.FAKE_HOST_CREDS_TOUCH, '{"host":"changed"}\n');
execFileSync(join(sandbox, "tools", "bin", "ai-collab"), ["task", "set", process.env.FAKE_BUILDER_TASK, "status=done"]);
