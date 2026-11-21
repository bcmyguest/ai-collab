// Stand-in harness process (spawned with argv0 "claude" or "codex"): runs each hook request on stdin as its child, so the session reads as online.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [hookPath] = process.argv.slice(2);
createInterface({ input: process.stdin }).on("line", (line) => {
  const { n, args, env, input } = JSON.parse(line);
  const child = spawn(process.execPath, [hookPath, ...args], { env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("close", (code) => process.stdout.write(JSON.stringify({ n, code, out }) + "\n"));
  child.stdin.end(JSON.stringify(input));
});
