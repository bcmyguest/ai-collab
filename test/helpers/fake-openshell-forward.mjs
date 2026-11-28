#!/usr/bin/env node
// fake-openshell.mjs plus `forward service`: prints openshell 0.1.9's Forwarding line with the port the fake
// `opencode serve` wrote in the sandbox home, then stays up until killed. Every other command goes to fake-openshell.mjs.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op

if (args[0] === "forward" && args[1] === "service") {
  if (process.env.FAKE_OPENSHELL_LOG) appendFileSync(process.env.FAKE_OPENSHELL_LOG, `${JSON.stringify(args)}\n`);
  const name = args[2];
  const target = args[args.indexOf("--target-port") + 1];
  const file = join(dirname(process.env.FAKE_OPENSHELL_STATE), "sandboxes", name, "home", ".fake-opencode-port");
  const end = Date.now() + 10_000;
  const poll = () => {
    if (existsSync(file) && readFileSync(file, "utf8")) {
      process.stdout.write(`✓ Forwarding 127.0.0.1:${readFileSync(file, "utf8")} -> 127.0.0.1:${target} in sandbox ${name} via gRPC\n`);
      setInterval(() => {}, 60_000);
      return;
    }
    if (Date.now() > end) { process.stderr.write(`fake forward: no server in ${name}\n`); process.exit(1); }
    setTimeout(poll, 20);
  };
  process.on("SIGTERM", () => process.exit(0));
  poll();
} else {
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "fake-openshell.mjs"), ...args], { stdio: "inherit" });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 1));
}
