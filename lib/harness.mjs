/**
 * Harness binary names that depend on the machine, in a leaf module so controls.mjs and start.mjs can both use them.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

// Cursor renamed its CLI to `agent`; `cursor-agent` is kept as the fallback for installs that predate it.
export const CURSOR_BINARIES = ["agent", "cursor-agent"];

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
