// Scripted `codex app-server` stand-in that stalls one request, for timeout and shutdown tests. Test-only; never the real CLI.
// FAKE_SILENT_MODE: "silent-init" never answers initialize; "silent-turn" never answers turn/start;
// "started" answers turn/start after a turn/started notification and never completes; "crash-after-start" exits after that.
// FAKE_SILENT_LOG gets "started" when the child starts.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (!process.argv.includes("app-server")) process.exit(0); // node --test may load helpers; run only as the app-server

const mode = process.env.FAKE_SILENT_MODE ?? "";
if (process.env.FAKE_SILENT_LOG) appendFileSync(process.env.FAKE_SILENT_LOG, "started\n");
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turns = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.method === undefined) return;
  const { id, method, params } = message;
  if (method === "initialize") {
    if (mode === "silent-init") return;
    return write({ id, result: {} });
  }
  if (method === "thread/start" || method === "thread/resume") return write({ id, result: { thread: { id: params.threadId ?? "thr_silent" } } });
  if (method === "turn/start") {
    if (mode === "silent-turn") return;
    const turn = { id: `turn-${++turns}`, items: [], status: "inProgress" };
    write({ method: "turn/started", params: { threadId: params.threadId, turn } });
    write({ id, result: { turn } });
    if (mode === "crash-after-start") process.exit(3);
    return;
  }
  if (method === "thread/unsubscribe") return write({ id, result: {} });
  return write({ id, error: { code: -32601, message: `fake does not answer ${method}` } });
});
