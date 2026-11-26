// Run in terminal on the UI server: watches request folders, lists cards in the snapshot, and runs a script on a Run click.
import { mkdirSync, watch } from "node:fs";
import { decideRun, listRunRequests, runInTerminalEnabled, runRoot } from "../../lib/run-terminal.mjs";
import { runAnswer, runOperations, runSurfaceId } from "../lib/a2ui-run.js";

/**
 * The UI server's run-in-terminal hooks; every hook is inert unless runInTerminal is on and the UI runs on the host
 * (not hosted). notify gets a push notice for each request that appears while the server runs.
 */
export function runTerminalUi({ env, hosted, broadcast, notify = () => {} }) {
  const on = () => !hosted && runInTerminalEnabled(env);
  const watchers = [];
  const seen = new Map();

  function scan(cfg) {
    const known = seen.get(cfg.project);
    for (const request of listRunRequests(cfg.stateDir, cfg.project)) {
      if (known.has(request.id)) continue;
      known.add(request.id);
      if (request.status === "pending") notify(cfg.project, request);
    }
  }

  return {
    /** Watches the project's request folder: a new request pushes the card and a notice. */
    watch(cfg) {
      if (!on()) return;
      const root = runRoot(cfg.stateDir, cfg.project);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      seen.set(cfg.project, new Set(listRunRequests(cfg.stateDir, cfg.project).map(request => request.id)));
      const watcher = watch(root, () => { scan(cfg); broadcast(); });
      watcher.unref();
      watchers.push(watcher);
    },
    /** {runRequests} for the snapshot, only the session's own in a session view; {} while off. */
    snapshot(cfg, session) {
      if (!on()) return {};
      const list = listRunRequests(cfg.stateDir, cfg.project).filter(request => !session || request.session === session);
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
      return decideRun({ stateDir: cfg.stateDir, project: cfg.project, ...answer, by: by ? `operator:${by}` : "operator", onUpdate: broadcast, env });
    },
    close() {
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}
