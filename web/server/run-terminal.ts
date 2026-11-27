// Run in terminal on the UI server: watches request folders, lists cards in the snapshot, and runs a script on a Run click.
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { SHOWN, closeRun, decideRun, listRunRequests, markLost, runInTerminalEnabled, runRoot, runStatus } from "../../lib/run-terminal.ts";
import { runAnswer, runOperations, runSurfaceId } from "../lib/a2ui-run.js";

const CHANGED = "the request changed after it was shown";

// oxlint-disable-next-line typescript/no-explicit-any -- run requests, pins and A2UI actions are JSON
type Json = any;
type TermCfg = { stateDir: string; project: string };
/** The snapshot's run cards; empty while run in terminal is off. */
type RunSnapshot = { runRequests?: Json[] };

/**
 * The UI server's run-in-terminal hooks; every hook is inert unless runInTerminal is on and the UI runs on the host
 * (not hosted). notify gets a push notice for each request that appears while the server runs.
 */
export function runTerminalUi({ env, hosted, broadcast, notify = () => {} }: {
  env: NodeJS.ProcessEnv; hosted?: boolean; broadcast: () => void; notify?: (project: string, request: Json) => void;
}) {
  const on = (): boolean => !hosted && runInTerminalEnabled(env);
  const watchers: FSWatcher[] = [];
  const seen = new Map<string, Set<string>>();
  // The fields of each request as this server first showed them; the card keeps showing them and Run requires them.
  const pins = new Map<string, Json>();

  function listed(cfg: TermCfg): Json[] {
    return listRunRequests(cfg.stateDir, cfg.project).map((request: Json) => {
      const key = cfg.project + "/" + request.id;
      const pin = pins.get(key);
      if (!pin) pins.set(key, Object.fromEntries(SHOWN.map(field => [field, request[field]])));
      if (!pin || SHOWN.every(field => pin[field] === request[field])) return request;
      closeRun(cfg.stateDir, cfg.project, request.id, CHANGED);
      return { ...request, ...runStatus(cfg.stateDir, cfg.project, request.id), ...pin };
    });
  }

  function scan(cfg: TermCfg): void {
    const known = seen.get(cfg.project) as Set<string>;
    for (const request of listed(cfg)) {
      if (known.has(request.id)) continue;
      known.add(request.id);
      if (request.status === "pending") notify(cfg.project, request);
    }
  }

  return {
    /** Closes runs a previous server left running as lost, then watches the request folder: a new request pushes the card and a notice. */
    watch(cfg: TermCfg): void {
      if (!on()) return;
      const root = runRoot(cfg.stateDir, cfg.project);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      markLost(cfg.stateDir, cfg.project);
      seen.set(cfg.project, new Set(listed(cfg).map(request => request.id)));
      const watcher = watch(root, () => { scan(cfg); broadcast(); });
      watcher.unref();
      watchers.push(watcher);
    },
    /** {runRequests} for the snapshot, only the session's own in a session view; {} while off. */
    snapshot(cfg: TermCfg, session?: string): RunSnapshot {
      if (!on()) return {};
      const list = listed(cfg).filter(request => !session || request.session === session);
      return { runRequests: list };
    },
    /** A2UI surfaces of the snapshot's run cards. */
    surfaces(current: Json, now: number): Json[] {
      return (current.runRequests || []).map((request: Json) => ({ id: runSurfaceId(request.id), operations: runOperations(request, now) }));
    },
    /** The decision for a run card's action, or null when the action belongs to another card. */
    answer(cfg: TermCfg, userAction: Json, by?: string): Json {
      const answer = runAnswer(userAction);
      if (!answer) return null;
      if (!on()) {
        const error: Error & { status?: number } = new Error("Run in terminal is off");
        error.status = 403;
        throw error;
      }
      return decideRun({ stateDir: cfg.stateDir, project: cfg.project, ...answer, pinned: pins.get(cfg.project + "/" + answer.id), by: by ? `operator:${by}` : "operator", onUpdate: broadcast, env });
    },
    close(): void {
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}
