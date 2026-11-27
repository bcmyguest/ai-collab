// `ai-collab builder ...`: start, run, list, stop and clean.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config.ts";
import { cleanBuilders } from "../builder-clean.ts";
import { BUILDER_HARNESSES, FINAL_PHASES, LIVE_STATES, builderPaths, readState } from "./state.ts";
import type { Env } from "./state.ts";
import { startBuilder, runBuilder, stopBuilder, unitState } from "./supervisor.ts";
import type { BuilderCfg } from "./supervisor.ts";

type Writer = { write: (chunk: string) => void };

const USAGE = {
  start: "usage: builder start --task <id> [--harness cursor|codex|claude|opencode] [--model M] --brief <file> [--branch B] [--run ID]",
  run: "usage: builder run <id>",
  list: "usage: builder list [--all]",
  stop: "usage: builder stop <id>",
  clean: "usage: builder clean",
};

export async function builder([sub, ...rest]: string[], { env, cfg, out, err }: { env: Env; cfg: BuilderCfg; out: Writer; err: Writer }) {
  const fail = (key: keyof typeof USAGE) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  try {
    if (sub === "start") {
      const flags = parseStart(rest);
      if (!flags?.task || !flags.brief || (flags.harness !== undefined && !BUILDER_HARNESSES.includes(flags.harness))) return fail("start");
      const result = await startBuilder(flags, { env, cfg, readBrief: () => readFileSync(flags.brief, "utf8") });
      out.write([result.session ?? result.unit, result.task, result.sandbox, result.worktree, result.branch].join("\t") + "\n");
      return 0;
    }
    if (sub === "run") return rest.length === 1 ? await runBuilder(rest[0], { env, cfg, out, err }) : fail("run");
    if (sub === "list") return await listBuilders(rest, { env, out, fail });
    if (sub === "stop") return rest.length === 1 ? await stopBuilder(rest[0], { env, out, err }) : fail("stop");
    if (sub === "clean") {
      if (rest.length !== 0) return fail("clean");
      for (const id of await cleanBuilders(env)) out.write(`${id}\n`);
      return 0;
    }
  } catch (error) {
    err.write(`ai-collab: builder ${sub}: ${(error as Error).message}\n`);
    return 1;
  }
  err.write(`ai-collab: ${Object.values(USAGE).join("\n  ")}\n`);
  return 1;
}

function parseStart(argv: string[]): Record<string, string> | null {
  const spec = ["--task", "--harness", "--model", "--brief", "--branch", "--run"];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const at = argv[i].indexOf("=");
    const [key, value] = at > 0 ? [argv[i].slice(0, at), argv[i].slice(at + 1)] : [argv[i], argv[i + 1]];
    if (!spec.includes(key) || value === undefined) return null;
    flags[key.slice(2)] = value;
    if (at < 0) i += 1;
  }
  return flags;
}

function listBuilders(argv: string[], { env, out, fail }: { env: Env; out: Writer; fail: (key: keyof typeof USAGE) => number }) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--all")) return fail("list");
  const all = argv[0] === "--all";
  const root = join(stateDir(env), "builders");
  const ids = existsSync(root) ? readdirSync(root).sort() : [];
  return Promise.all(ids.map(async (id) => {
    const paths = builderPaths(id, env);
    let state;
    try { state = readState(paths); } catch { return null; }
    if (state.owned) {
      if (!all && FINAL_PHASES.includes(state.phase)) return null;
      return [state.address || state.unit, state.task, state.sandbox, state.phase, state.phase].join("\t");
    }
    const active = await unitState(state.unit, env);
    if (!all && !LIVE_STATES.includes(active) && FINAL_PHASES.includes(state.phase)) return null;
    return `${state.unit}\t${state.task}\t${state.sandbox}\t${state.phase}\t${active}`;
  })).then((rows) => {
    for (const row of rows.filter(Boolean)) out.write(`${row}\n`);
    return 0;
  });
}
