#!/usr/bin/env node
// Fake oncebitten for builder tests: `capture` appends its stdin to FAKE_ONCEBITTEN_LOG; `check` exits FAKE_ONCEBITTEN_CHECK.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
if (args[0] === "capture") {
  const payload = readFileSync(0, "utf8");
  if (process.env.FAKE_ONCEBITTEN_LOG) appendFileSync(process.env.FAKE_ONCEBITTEN_LOG, `${JSON.stringify({ args, cwd: process.cwd(), payload })}\n`);
  process.exit(0);
}
if (args[0] === "check") {
  if (process.env.FAKE_ONCEBITTEN_LOG) appendFileSync(process.env.FAKE_ONCEBITTEN_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
  const code = Number(process.env.FAKE_ONCEBITTEN_CHECK || 0);
  if (code === 1) process.stdout.write("no-sleep-in-tests fired in test/x.test.mjs:3\n");
  process.exit(code);
}
process.exit(2);
