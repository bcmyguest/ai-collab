#!/usr/bin/env node
// Fake sandboxed builder agent: edits, commits, fires the capture hook and records `ai-collab task set`, per FAKE_BUILDER_MODE.
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { get } from "node:http";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
const mode = process.env.FAKE_BUILDER_MODE || "commit";
// The fake openshell maps /sandbox/ to a host directory; HOME is <that>/home.
const sandbox = dirname(process.env.HOME);
if (process.env.FAKE_BUILDER_LOG) appendFileSync(process.env.FAKE_BUILDER_LOG, `${JSON.stringify({ args, cwd: process.cwd(), path: process.env.PATH, gitExec: process.env.GIT_EXEC_PATH || "" })}\n`);
if (process.env.FAKE_CURSOR_API_PORT) {
  // Model the broker needing to inspect the Cursor process before it can route egress.
  if (process.env.CURSOR_AGENT_ALLOW_PROCESS_INSPECTION !== "1") throw new Error("getaddrinfo EAI_AGAIN api2.cursor.sh");
  await new Promise((resolve, reject) => {
    get({
      hostname: "127.0.0.1",
      port: process.env.FAKE_CURSOR_API_PORT,
      path: "/probe",
      headers: { host: "api2.cursor.sh" },
      signal: AbortSignal.timeout(5_000),
    }, async (response) => {
      try {
        let body = "";
        for await (const chunk of response) body += chunk;
        if (response.statusCode !== 200 || body !== "cursor-ok") throw new Error("fake Cursor API probe failed");
        resolve();
      } catch (error) {
        reject(error);
      }
    }).on("error", reject);
  });
}
if (mode === "fail") process.exit(3);
if (mode === "restart" && !readFileSync("notes.md", "utf8").includes("pending fallback edit")) {
  appendFileSync("notes.md", "pending fallback edit\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === "cursor-limit") {
  console.error("ActionRequiredError: You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 12/18/2099.");
  process.exit(1);
}
if (mode !== "empty") appendFileSync(join(process.cwd(), "notes.md"), "a line from the builder\n");
if (mode === "commit") {
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-q", "-m", "docs: add a line"]);
  if (args[0] !== "run") {
    const hooks = JSON.parse(readFileSync(join(process.env.HOME, ".cursor", "hooks.json"), "utf8")).hooks;
    const command = hooks.postToolUse[0].command.split("/sandbox/").join(`${sandbox}/`);
    execFileSync("sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "postToolUse", cwd: `/sandbox/work/${basename(process.cwd())}` }) });
  }
}
if (mode === "commit" || mode === "empty" || mode === "restart") {
  const task = process.env.FAKE_BUILDER_TASK;
  execFileSync(join(sandbox, "tools", "bin", "ai-collab"), ["task", "progress", task, "half way"]);
  execFileSync(join(sandbox, "tools", "bin", "ai-collab"), ["task", "set", task, "status=done"]);
}
process.exit(0);
