/** `ai-collab spawn`: the shell form of the spawn_agent MCP tool (lib/spawn.ts). */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { spawnAgent } from "./spawn.ts";

const USAGE = "usage: spawn <harness[:model]> [--model M] [--worktree] (--brief \"<task>\" | --brief-file <path> | -)";

type Io = { env: NodeJS.ProcessEnv; cfg: { enabled?: boolean; reason?: string; project: string; peer: string; session?: string }; out: { write(s: string): void }; err: { write(s: string): void }; readStdin: () => Promise<string>; spawn?: typeof spawnAgent };

/** Exit 0 on a start, 2 on a usage error, 1 when the runner refuses. */
export async function spawn(argv: string[], { env, cfg, out, err, readStdin, spawn: start = spawnAgent }: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { model: { type: "string" }, worktree: { type: "boolean" }, brief: { type: "string" }, "brief-file": { type: "string" } } });
  } catch {
    err.write(`ai-collab: ${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const stdin = positionals.includes("-");
  const rest = positionals.filter((w) => w !== "-");
  const sources = [values.brief !== undefined, values["brief-file"] !== undefined, stdin].filter(Boolean).length;
  if (rest.length !== 1 || sources !== 1) { err.write(`ai-collab: ${USAGE}\n`); return 2; }
  if (!cfg.enabled) { err.write(`ai-collab: disabled: ${cfg.reason}\n`); return 2; }
  let brief: string;
  try {
    brief = values.brief ?? (values["brief-file"] ? readFileSync(values["brief-file"], "utf8") : await readStdin());
  } catch (error) {
    err.write(`ai-collab: spawn: ${(error as Error).message}\n`);
    return 2;
  }
  try {
    const started = await start(cfg, { harness: rest[0], brief, worktree: values.worktree === true, ...(values.model ? { model: values.model } : {}) }, { env });
    out.write(`started ${started.session} (${started.harness}${started.model ? `:${started.model}` : ""}, ${started.cwd})\n`);
    return 0;
  } catch (error) {
    err.write(`ai-collab: spawn: ${(error as Error).message}\n`);
    return 1;
  }
}
