// Run in terminal on the UI server: watches request folders, lists cards in the snapshot, and runs a script on a Run click.
import { mkdirSync, watch } from "node:fs";
import { SHOWN, closeRun, decideRun, listRunRequests, markLost, runInTerminalEnabled, runRoot, runStatus } from "../../lib/run-terminal.ts";
import { runAnswer, runOperations, runSurfaceId } from "../lib/a2ui-run.js";

const CHANGED = "the request changed after it was shown";

/**
 * The UI server's run-in-terminal hooks; every hook is inert unless runInTerminal is on and the UI runs on the host
 * (not hosted). notify gets a push notice for each request that appears while the server runs.
 */
export function runTerminalUi({ env, hosted, broadcast, notify = () => {} }) {
  const on = () => !hosted && runInTerminalEnabled(env);
  const watchers = [];
  const seen = new Map();
  // The fields of each request as this server first showed them; the card keeps showing them and Run requires them.
  const pins = new Map();

  function listed(cfg) {
    return listRunRequests(cfg.stateDir, cfg.project).map(request => {
      const key = cfg.project + "/" + request.id;
      const pin = pins.get(key);
      if (!pin) pins.set(key, Object.fromEntries(SHOWN.map(field => [field, request[field]])));
      if (!pin || SHOWN.every(field => pin[field] === request[field])) return request;
      closeRun(cfg.stateDir, cfg.project, request.id, CHANGED);
      return { ...request, ...runStatus(cfg.stateDir, cfg.project, request.id), ...pin };
    });
  }

  function scan(cfg) {
    const known = seen.get(cfg.project);
    for (const request of listed(cfg)) {
      if (known.has(request.id)) continue;
      known.add(request.id);
      if (request.status === "pending") notify(cfg.project, request);
    }
  }

  return {
    /** Closes runs a previous server left running as lost, then watches the request folder: a new request pushes the card and a notice. */
    watch(cfg) {
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
    snapshot(cfg, session) {
      if (!on()) return {};
      const list = listed(cfg).filter(request => !session || request.session === session);
      return { runRequests: list };
    },
    /** A2UI surfaces of the snapshot's run cards. */
    surfaces(current, now) {
      return (current.runRequests || []).map(request => ({ id: runSurfaceId(request.id), operations: runOperations(request, now) }));
    },
    /** The decision for a run card's action, or null when the action belongs to another card. */
    answer(cfg, userAction, by) {
      const answer = runAnswer(userAction);
      if (!answer) return null;
      if (!on()) {
        const error = new Error("Run in terminal is off");
        error.status = 403;
        throw error;
      }
      return decideRun({ stateDir: cfg.stateDir, project: cfg.project, ...answer, pinned: pins.get(cfg.project + "/" + answer.id), by: by ? `operator:${by}` : "operator", onUpdate: broadcast, env });
    },
    close() {
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}
