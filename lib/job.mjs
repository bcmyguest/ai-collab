import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { isRunning, processStart } from "./process.mjs";
import { writeState } from "./state.mjs";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const USAGE = "usage: ai-collab job run -- <command> [args...]";

/** Active commands for a local session. Process start times distinguish reused PIDs. */
export function runningJobs(registry, address, files) {
  const prefix = address + ".job-";
  let count = 0;
  for (const name of files) {
    if (!name.startsWith(prefix) || !/^[a-f0-9-]{36}\.json$/.test(name.slice(prefix.length))) continue;
    const file = join(registry, name);
    try {
      const job = JSON.parse(readFileSync(file, "utf8"));
      if (typeof job.start === "string" && isRunning(job)) count++;
      else rmSync(file, { force: true });
    } catch { /* Missing or unreadable record. */ }
  }
  return count;
}

export async function job(argv, { cfg, env, out, err, registered }) {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]) ||
      (argv[0] === "run" && ["--help", "-h"].includes(argv[1]))) {
    out.write(USAGE + "\n");
    return 0;
  }
  const [sub, separator, command, ...args] = argv;
  if (sub !== "run" || separator !== "--" || !command) {
    err.write(USAGE + "\n");
    return 2;
  }
  try {
    if (!cfg.enabled) throw new Error(cfg.reason);
    const address = `${cfg.peer}#${cfg.session}`;
    if (!cfg.session || !registered(cfg, address)) {
      throw new Error("Set AI_COLLAB_PEER and AI_COLLAB_SESSION to your registered session");
    }
    const file = join(cfg.stateDir, cfg.project, "registry", address + ".job-" + randomUUID() + ".json");
    const child = spawn(command, args, { env, stdio: "inherit" });
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
    });
    const handlers = SIGNALS.map(signal => [signal, () => child.kill(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
      const start = child.pid && processStart(child.pid);
      if (start) writeState(file, { pid: child.pid, start });
      return await completion;
    } catch (error) {
      child.kill("SIGKILL");
      await completion.catch(() => {});
      throw error;
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      rmSync(file, { force: true });
    }
  } catch (error) {
    err.write(`ai-collab: job: ${error.message}\n`);
    return error.code === "ENOENT" ? 127 : 1;
  }
}
