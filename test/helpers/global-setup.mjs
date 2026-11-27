import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test dir lands in one per-run dir, so leftovers are detected and removed at teardown.
let runDir;

export async function globalSetup() {
  runDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-run-"));
  process.env.TMPDIR = runDir;
}

export async function globalTeardown() {
  const leaked = readdirSync(runDir);
  rmSync(runDir, { recursive: true, force: true });
  if (!leaked.length) return;
  const message = `test run leaked ${leaked.length} temp entries:\n${leaked.join("\n")}`;
  console.error(message);
  throw new Error(message);
}
