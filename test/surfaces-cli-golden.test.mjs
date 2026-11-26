import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import { quietEnv } from "./helpers/surface-env.mjs";

const UPDATE = process.env.UPDATE_SURFACE_GOLDEN === "1";
const GOLDEN = fileURLToPath(new URL("./golden/surfaces/cli.json", import.meta.url));
const CASES = [
  ["help"],
  ["--help"],
  ["bogus-command"],
  ["send"],
  ["send", "all", "--bogus"],
  ["identity", "--bogus"],
  ["respond"],
  ["history", "--limit", "0"],
  ["wait", "idle:nobody"],
  ["sessions"],
  ["agents"],
  ["afk"],
  ["team", "list"],
  ["task", "help"],
  ["mission", "help"],
  ["pattern", "list"],
];

async function capture(argv) {
  let stdout = "";
  let stderr = "";
  const env = quietEnv();
  const code = await runCli(argv, {
    env,
    agent: false,
    readStdin: async () => "",
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { argv, code, stdout, stderr: stderr.replaceAll(env.AI_COLLAB_STATE_DIR, "<state>") };
}

test("ai-collab CLI usage and representative outputs match the golden", { timeout: 20000 }, async () => {
  const actual = [];
  for (const argv of CASES) actual.push(await capture(argv));
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) writeFileSync(GOLDEN, text);
  assert.equal(text, readFileSync(GOLDEN, "utf8"));
});
