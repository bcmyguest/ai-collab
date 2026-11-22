#!/usr/bin/env node
// Fake systemd-run and systemctl for builder tests: systemd-run runs the unit's command to completion in the foreground.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
const self = basename(process.argv[1]);
if (process.env.FAKE_SYSTEMD_LOG) appendFileSync(process.env.FAKE_SYSTEMD_LOG, `${JSON.stringify([self, ...args])}\n`);

if (self === "systemctl") {
  if (args.includes("show")) process.stdout.write(`${process.env.FAKE_SYSTEMCTL_STATE || "inactive"}\n`);
  process.exit(0);
}
const env = { ...process.env };
let cwd;
let i = 0;
for (; i < args.length && args[i].startsWith("--"); i += 1) {
  if (args[i].startsWith("--setenv=")) { const [k, ...v] = args[i].slice(9).split("="); env[k] = v.join("="); }
  if (args[i].startsWith("--working-directory=")) cwd = args[i].slice(20);
}
const run = spawnSync(args[i], args.slice(i + 1), { env, cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
if (process.env.FAKE_SYSTEMD_UNIT_LOG) appendFileSync(process.env.FAKE_SYSTEMD_UNIT_LOG, `${run.stdout}${run.stderr}`);
process.exit(run.error ? 1 : 0);
