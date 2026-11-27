import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// Removals deferred to the end of the test file, and run again at exit for writes that land after the last hook.
const late = [];
// The first pass may race a child still writing; the exit pass retries and lets an error surface.
after(() => { for (const rm of late) try { rm(); } catch { /* retried at exit */ } });
process.on("exit", () => { for (const rm of late) rm(); });

/** A tempDir context whose cleanup runs when the test file ends rather than when the test ends. */
export const fileEnd = { after: (fn) => late.push(fn) };

/** Creates a temp dir under os.tmpdir() and removes it when the test or suite ends. */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
