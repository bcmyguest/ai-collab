/**
 * Harness binary names that depend on the machine or the place a session runs in. A leaf module, so controls.mjs
 * and start.mjs both take their names from here.
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

// Cursor renamed its CLI to `agent`; `cursor-agent` is kept as the fallback for installs that predate it.
export const CURSOR_BINARIES = ["agent", "cursor-agent"];
// The name the Cursor CLI is linked under inside an openshell sandbox (builder.mjs and runner/sandbox-run.mjs).
const SANDBOX_CURSOR = "cursor-agent";

/** The child's PATH: the caller's first, then node's directory and ~/.local/bin. */
export function childPath(env = process.env, execPath = process.execPath) {
  return [env.PATH, dirname(execPath), join(env.HOME || homedir(), ".local", "bin")].filter(Boolean).join(delimiter);
}

/** The Cursor CLI's binary name on this PATH: the first directory holding `agent` or the older `cursor-agent` decides. */
export function cursorBinary(path = "") {
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    const found = CURSOR_BINARIES.find((name) => {
      try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
    });
    if (found) return found;
  }
  return CURSOR_BINARIES[0];
}

/** The Cursor binary a session runs under in `place`: the host's name on `path`, or the sandbox's link name. */
export function cursorCommandFor({ path = "", place = "folder" } = {}) {
  return place === "openshell" ? SANDBOX_CURSOR : cursorBinary(path);
}
