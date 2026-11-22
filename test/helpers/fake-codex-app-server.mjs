// Scripted stand-in for `codex app-server` (newline-delimited JSON-RPC on stdio). Test-only; never the real CLI.
// Prompt text picks the script: "approve: <cmd>", "hang", "fail", "crash", else an echo. FAKE_CODEX_LOG gets one JSON line per request.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// node --test runs every file under test/; exit unless started as the app-server or for --version.
if (!process.argv.includes("app-server") && !process.argv.includes("--version")) process.exit(0);

const LOG = process.env.FAKE_CODEX_LOG;
const log = (entry) => { if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`); };
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
// A prompt containing "closing" meets a thread still closing for its first FAKE_CODEX_CLOSING_TIMES turn/start
// requests (default 0, so other tests are untouched): the server answers with an error and runs no turn.
let closingRefusals = Number(process.env.FAKE_CODEX_CLOSING_TIMES ?? 0);

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.171.0 (fake)\n");
  process.exit(0);
}

log({ kind: "start", argv: process.argv.slice(2), owned: process.env.AI_COLLAB_OWNED ?? null });

let threads = 0;
let turns = 0;
let serverIds = 1000;
const hanging = new Map(); // turnId -> threadId, turns waiting for interrupt
const waitingApproval = new Map(); // server request id -> { threadId, turnId, itemId, command }

function notify(method, params) { write({ method, params }); }

function finishTurn(threadId, turnId, status, error) {
  notify("turn/completed", { threadId, turn: { id: turnId, items: [], status, ...(error ? { error } : {}) } });
}

function runTurn(threadId, text) {
  const turnId = `turn-${++turns}`;
  notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
  const approve = /approve: (.+)/.exec(text);
  if (approve) {
    const id = ++serverIds;
    const itemId = `cmd-${turnId}`;
    waitingApproval.set(id, { threadId, turnId, itemId, command: approve[1] });
    write({ id, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId, startedAtMs: Date.now(), command: approve[1], cwd: "/tmp" } });
    return;
  }
  if (/\bhang\b/.test(text)) { hanging.set(turnId, threadId); return; }
  if (/\bfail\b/.test(text)) { finishTurn(threadId, turnId, "failed", { message: "fake turn failure" }); return; }
  if (/\blimit\b/.test(text)) { finishTurn(threadId, turnId, "failed", { message: "fake usage limit reached", codexErrorInfo: "usageLimitExceeded" }); return; }
  if (/\bcrash\b/.test(text)) { process.exit(3); }
  if (/\bask\b/.test(text)) {
    // A server request the adapter does not answer: it must reply with an error.
    write({ id: ++serverIds, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: `ask-${turnId}`, questions: [] } });
    finishTurn(threadId, turnId, "completed");
    return;
  }
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: `echo: ${text}` } });
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { last: { totalTokens: 1234 }, total: { totalTokens: 1234 }, modelContextWindow: 200000 } });
  finishTurn(threadId, turnId, "completed");
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) {
    // A response to one of our server requests (approvals, or an error for an unanswered request).
    log({ kind: "response", id, result: message.result ?? null, error: message.error ?? null });
    const pending = waitingApproval.get(id);
    if (!pending) return;
    waitingApproval.delete(id);
    const accepted = message.result?.decision === "accept";
    notify("item/completed", { threadId: pending.threadId, turnId: pending.turnId, item: { type: "commandExecution", id: pending.itemId, command: pending.command, commandActions: [], cwd: "/tmp", status: accepted ? "completed" : "declined", aggregatedOutput: accepted ? `ran ${pending.command}` : "", exitCode: accepted ? 0 : null } });
    finishTurn(pending.threadId, pending.turnId, "completed");
    return;
  }
  log({ kind: "request", method, params: params ?? null });
  switch (method) {
    case "initialize":
      return write({ id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
    case "initialized":
      return;
    case "thread/start": {
      const threadId = `thr-${++threads}`;
      return write({ id, result: { thread: { id: threadId }, cwd: params.cwd, model: params.model ?? "gpt-fake", modelProvider: "fake", approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: { type: "readOnly" } } });
    }
    case "thread/resume":
      return write({ id, result: { thread: { id: params.threadId } } });
    case "turn/start": {
      const text = params.input[0].text;
      if (/closing/.test(text) && closingRefusals > 0) {
        closingRefusals -= 1;
        return write({ id, error: { code: -32000, message: "thread is closing" } });
      }
      // Respond first, then run: the adapter learns the turn id from the response.
      write({ id, result: { turn: { id: `turn-${turns + 1}`, items: [], status: "inProgress" } } });
      return runTurn(params.threadId, text);
    }
    case "turn/steer":
      return write({ id, result: { turnId: params.expectedTurnId } });
    case "turn/interrupt": {
      write({ id, result: {} });
      const threadId = hanging.get(params.turnId);
      if (threadId) { hanging.delete(params.turnId); finishTurn(threadId, params.turnId, "interrupted"); }
      return;
    }
    case "thread/unsubscribe":
      return write({ id, result: {} });
    case "model/list":
      return write({ id, result: { data: [{ id: "gpt-fake", model: "gpt-fake", displayName: "GPT Fake", isDefault: true, hidden: false }], nextCursor: null } });
    case "skills/list":
      return write({ id, result: { data: [{ cwd: params.cwds[0], errors: [], skills: [{ name: "fake-skill", description: "a fake skill" }] }] } });
    default:
      return write({ id, error: { code: -32601, message: `fake: no ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message);
});
