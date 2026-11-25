/**
 * Harness names, their binaries, the `harness:model` text form and the fallback model. A leaf module: start, controls,
 * config, limit alerts, teams, patterns, DOT and team authoring all take these from here.
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export const HARNESSES = ["claude", "codex", "cursor", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];
export type HarnessModel = { harness: Harness; model: string };

// The Cursor model every built-in default and fallback uses.
export const FALLBACK_MODEL = "deepseek-v41-flash-1017-high";
// Shape of a model name a start may pass; membership in lib/models.mjs's allowlist is checked by the caller.
export const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,79}$/;
// OpenCode names a model provider/model#variant (`opencode run --help`); the model part may hold more slashes.
export const OPENCODE_MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}\/[a-zA-Z0-9][a-zA-Z0-9._:@/[\]-]{0,119}(#[a-zA-Z0-9._-]{1,40})?$/;
// Cursor renamed its CLI to `agent`; `cursor-agent` is kept as the fallback for installs that predate it.
export const CURSOR_BINARIES: readonly string[] = ["agent", "cursor-agent"];
// The harness each agent binary runs as, by the binary's name. A Map, so a name like "constructor" finds nothing.
const BINARY_HARNESS = new Map<string, Harness>([
  ["agent", "cursor"],
  ["cursor-agent", "cursor"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
]);

/** Whether a name is one of the four harnesses. */
export function isHarness(name: unknown): name is Harness {
  return typeof name === "string" && (HARNESSES as readonly string[]).includes(name);
}

/** The harness an agent binary runs as, by its name; undefined for any other program. */
export function harnessOfBinary(name: string): Harness | undefined {
  return BINARY_HARNESS.get(name);
}

/** Whether a model name has the shape this harness's start may pass. */
export function modelShape(harness: string, model: unknown): boolean {
  return typeof model === "string" && (harness === "opencode" ? OPENCODE_MODEL_NAME : MODEL_NAME).test(model);
}

/** Parses "harness" or "harness:model"; the model must pass modelShape. Null for anything else, a bare harness gives model "". */
export function parseHarnessModel(text: unknown): HarnessModel | null {
  if (typeof text !== "string") return null;
  const at = text.indexOf(":");
  const harness = at < 0 ? text : text.slice(0, at);
  const model = at < 0 ? "" : text.slice(at + 1);
  if (!isHarness(harness) || (at >= 0 && !modelShape(harness, model))) return null;
  return { harness, model };
}

/** "harness:model", or "harness" when the model is empty. */
export function formatHarnessModel({ harness, model }: HarnessModel): string {
  return model ? `${harness}:${model}` : harness;
}

/** The child's PATH: the caller's first, then node's directory and ~/.local/bin. */
export function childPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string {
  return [env.PATH, dirname(execPath), join(env.HOME || homedir(), ".local", "bin")].filter(Boolean).join(delimiter);
}

/** The Cursor CLI's binary name on this PATH: the first directory holding `agent` or the older `cursor-agent` decides. */
export function cursorBinary(path = ""): string {
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    const found = CURSOR_BINARIES.find((name) => {
      try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
    });
    if (found) return found;
  }
  return CURSOR_BINARIES[0];
}

/** The Cursor binary a start or wake runs: the name cursorBinary finds on `path`. */
export function cursorCommandFor({ path = "" }: { path?: string } = {}): string {
  return cursorBinary(path);
}
