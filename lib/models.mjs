/**
 * Model allowlists for sessions started from the phone, so only a listed name reaches a harness's argv.
 * claude: aliases and full ids from https://code.claude.com/docs/en/model-config (#model-aliases).
 * codex: visible slugs in $CODEX_HOME/models_cache.json (Codex's own model catalog cache) plus config.toml's model.
 * cursor: `cursor-agent --list-models`, cached in the state dir for a day.
 * opencode: `opencode models` (provider/model per line), cached the same way.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_NAME, childEnv, cursorBinary, findExecutable, modelShape } from "./start.mjs";

export const CLAUDE_MODELS = [
  "fable", "opus", "sonnet", "haiku", "best", "opusplan", "sonnet[1m]", "opus[1m]",
  "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8",
  "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-1", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5",
  "claude-haiku-5-5", "claude-haiku-4-5",
];
const CURSOR_CACHE_MS = 24 * 3600_000;
const CURSOR_TIMEOUT_MS = 20_000;
const CURSOR_LINE = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,79}) - \S/;

const valid = (list) => [...new Set(list.filter((name) => typeof name === "string" && MODEL_NAME.test(name)))];

/** Codex models: the catalog cache's listed slugs, plus the model set in config.toml. */
export function codexModels(env = process.env) {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  let listed = [];
  try {
    const models = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")).models;
    if (Array.isArray(models)) listed = models.filter((m) => m?.visibility !== "hide").map((m) => m?.slug);
  } catch { /* no cache yet */ }
  let configured = "";
  try {
    configured = /^model\s*=\s*"([^"\n]+)"/m.exec(readFileSync(join(home, "config.toml"), "utf8"))?.[1] || "";
  } catch { /* no config */ }
  return valid([configured, ...listed]);
}

/** Model names from `cursor-agent --list-models` output: lines of "<name> - <label>". */
export function parseCursorModels(text) {
  return valid(String(text).split("\n").map((line) => CURSOR_LINE.exec(line.trim())?.[1]));
}

/** Model names from `opencode models` output: the first word of each line, shaped provider/model. */
export function parseOpenCodeModels(text) {
  const names = String(text).split("\n").map((line) => line.trim().split(/\s+/)[0]);
  return [...new Set(names.filter((name) => modelShape("opencode", name)))];
}

function runList(file, env, args = ["--list-models"]) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: CURSOR_TIMEOUT_MS, maxBuffer: 1 << 20, shell: false }, (error, stdout) => {
      resolve(error ? "" : String(stdout));
    });
  });
}

// A model list from a day-old cache file or a fresh run of the harness's list command; a stale cache when the run fails.
async function cachedList(stateDir, env, { name, executable, args, parse, check, now, run }) {
  const cache = join(stateDir, `models-${name}.json`);
  let cached = null;
  try {
    const value = JSON.parse(readFileSync(cache, "utf8"));
    if (Array.isArray(value.list) && Number.isFinite(value.at)) cached = { at: value.at, list: value.list.filter(check) };
  } catch { /* none */ }
  if (cached && now - cached.at < CURSOR_CACHE_MS) return cached.list;
  const vars = childEnv(env);
  const file = findExecutable(executable, vars.PATH);
  const list = file ? parse(await run(file, vars, args)) : [];
  if (!list.length) return cached?.list || [];
  try {
    mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
    writeFileSync(cache, JSON.stringify({ at: now, list }), { mode: 0o600 });
  } catch { /* uncached */ }
  return list;
}

/** Cursor models, from a day-old cache or a fresh `<cursor cli> --list-models`; a stale cache when the command fails. */
export function cursorModels(stateDir, env = process.env, { now = Date.now(), run = runList } = {}) {
  const check = (name) => typeof name === "string" && MODEL_NAME.test(name);
  // A bare name: cachedList resolves it against PATH, and cursorBinary already chose which name that is.
  const executable = cursorBinary(childEnv(env).PATH);
  return cachedList(stateDir, env, { name: "cursor", executable, args: ["--list-models"], parse: parseCursorModels, check, now, run });
}

/** OpenCode models, from a day-old cache or a fresh `opencode models` (which uses OpenCode's background server). */
export function opencodeModels(stateDir, env = process.env, { now = Date.now(), run = runList } = {}) {
  const check = (name) => modelShape("opencode", name);
  return cachedList(stateDir, env, { name: "opencode", executable: "opencode", args: ["models"], parse: parseOpenCodeModels, check, now, run });
}

/** {claude, codex, cursor, opencode}: the names each harness accepts in a start request; peers skips unlisted CLIs. */
export async function listModels(stateDir, env = process.env, options = {}) {
  const { peers = [], ...rest } = options;
  const wanted = (h) => !peers.length || peers.includes(h);
  return {
    claude: [...CLAUDE_MODELS], codex: codexModels(env), cursor: await cursorModels(stateDir, env, rest),
    opencode: wanted("opencode") ? await opencodeModels(stateDir, env, rest) : [],
  };
}
