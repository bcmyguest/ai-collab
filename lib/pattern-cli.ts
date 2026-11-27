/** `ai-collab pattern ...`: list, show, create, delete, start, runs, status, advance. */
import { readFileSync } from "node:fs";
import { listModels } from "./models.ts";
import { createPattern, deletePattern, getPattern, listPatterns } from "./patterns.mjs";
import { advanceRun, listRuns, runStatus, startRun } from "./pattern-runs.mjs";
import { passJs } from "./surfaces/types.ts";
import type { Cfg } from "./messaging.ts";

type Writer = { write: (chunk: string) => void };
type Io = { readStdin?: () => Promise<string> | string };

const USAGE = {
  list: "usage: pattern list",
  show: "usage: pattern show <name>",
  create: "usage: pattern create <file.json | ->",
  delete: "usage: pattern delete <name>",
  start: "usage: pattern start <name> \"<task>\"",
  runs: "usage: pattern runs",
  status: "usage: pattern status <run-id>",
  advance: "usage: pattern advance <run-id> \"<event>\" [\"note\"]",
};

async function readText(file: string | undefined, io: Io): Promise<string> {
  if (file && file !== "-") return readFileSync(file, "utf8");
  return io.readStdin ? io.readStdin() : "";
}

export async function pattern([sub, ...rest]: string[], { env, cfg, out, err, io }: { env: NodeJS.ProcessEnv; cfg: Cfg; out: Writer; err: Writer; io: Io }): Promise<number> {
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  const models = () => listModels(cfg.stateDir, env, { peers: cfg.peers });
  const fail = (key: keyof typeof USAGE) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  try {
    if (sub === undefined || sub === "list") {
      if (rest.length) return fail("list");
      const all = listPatterns(cfg, env);
      const names = Object.keys(all).sort();
      if (!names.length) out.write("no patterns configured\n");
      for (const name of names) {
        const p = all[name];
        const shape = p.invalid ? `invalid: ${p.invalid}` : p.legacy ? `${p.roles.length} members` : `${p.roles.length} roles, ${p.handoffs.length} handoffs`;
        out.write(`${name}\t${p.source}\t${shape}\n`);
      }
      return 0;
    }
    if (sub === "show") {
      const [name] = rest;
      if (!name || rest.length > 1) return fail("show");
      out.write(`${JSON.stringify(getPattern(cfg, name, env), null, 2)}\n`);
      return 0;
    }
    if (sub === "create") {
      if (rest.length > 1) return fail("create");
      const raw = JSON.parse(await readText(rest[0], io) || "null");
      const saved = await createPattern(cfg, raw, env, await models());
      out.write(`pattern ${saved.name}: ${saved.roles.length} roles, ${saved.handoffs.length} handoffs\n`);
      return 0;
    }
    if (sub === "delete") {
      const [name] = rest;
      if (!name || rest.length > 1) return fail("delete");
      out.write(`deleted ${deletePattern(cfg, name, env).deleted}\n`);
      return 0;
    }
    if (sub === "start") {
      const [name, ...words] = rest;
      if (!name) return fail("start");
      const task = words.join(" ") || String(await readText("", io) || "").trim();
      if (!task) { err.write("ai-collab: pattern start: missing task\n"); return 1; }
      const result = await startRun(cfg, name, task, env, passJs({ models: await models() }));
      out.write(`${result.id}\t${result.status}\t${result.active}\t${result.session || "-"}\t${result.detail || ""}\n`);
      return result.status === "failed" ? 1 : 0;
    }
    if (sub === "runs") {
      if (rest.length) return fail("runs");
      for (const run of listRuns(cfg)) out.write(`${run.id}\t${run.pattern}\t${run.status}\tactive ${run.active}\n`);
      return 0;
    }
    if (sub === "status") {
      const [id] = rest;
      if (!id || rest.length > 1) return fail("status");
      const run = runStatus(cfg, id);
      out.write(`run ${run.id}\t${run.pattern}\t${run.status}\tactive ${run.active}${run.error ? `\terror: ${run.error}` : ""}\n`);
      for (const [role, address] of Object.entries(run.sessions ?? {})) out.write(`session\t${role}\t${address}\n`);
      for (const note of run.notes ?? []) out.write(`note\t${note}\n`);
      for (const h of run.handoffs) {
        const override = h.override ? `\toperator override ${h.by}` : "";
        const text = h.note ? `\tnote (untrusted): ${h.note}` : "";
        out.write(`${h.seq}\t${h.from} -> ${h.to}\t"${h.on}"\t${h.at ? new Date(h.at).toISOString() : ""}${override}${text}\n`);
      }
      return 0;
    }
    if (sub === "advance") {
      const [id, event, ...words] = rest;
      if (!id || !event) return fail("advance");
      // The caller must be the active role's session; the CLI has no operator override.
      const caller = cfg.session ? `${cfg.peer}#${cfg.session}` : "";
      const result = await advanceRun(cfg, id, event, { note: words.join(" "), caller, env });
      out.write(`${result.id}\t${result.status}\t${result.active}\t${result.detail || ""}\n`);
      return result.status === "failed" ? 1 : 0;
    }
    err.write(`ai-collab: unknown pattern command "${sub}"\n`);
    return 1;
  } catch (e) {
    err.write(`ai-collab: pattern: ${(e as Error).message}\n`);
    return 1;
  }
}
