// Cursor adapter: one `<cursor cli> acp` child per owned session over stdio JSON-RPC, optionally inside an OpenShell sandbox.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../../lib/config.mjs";
import { cursorBinary, findExecutable } from "../../lib/start.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, permissionSettings } from "../contract.mjs";
import { builderPolicy } from "../../lib/builder.mjs";
import {
  destroySandbox, downloadTree, ensureSandbox as ensureSandboxIn, execArgv as sandboxExecArgv, runTool,
  sandboxName as sandboxNameFor, uploadFile, uploadTree,
} from "../sandbox.mjs";

// ACP protocolVersion 1 and the method names come from the ACP spec; `agent acp` answered `initialize`
// with protocolVersion 1 on 2026-11-22 (docs/owned-sessions-contract.md, Cursor adapter).
const PROTOCOL_VERSION = 1;
const SETUP_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 60_000;
const SANDBOX_TIMEOUT_MS = 600_000;
const CLIENT = { name: "ai-collab-runner", version: "0" };
const OWNED = { AI_COLLAB_OWNED: "cursor" };
// Where a sandbox session's worktree lives inside the sandbox and the home its CLI runs with.
const SANDBOX_ROOT = "/sandbox";
const SANDBOX_HOME = "/sandbox/home";
const SANDBOX_BIN = "/sandbox/bin";
// The name the CLI is launched by inside a sandbox, whatever it is called on the host.
const SANDBOX_LAUNCHER = "cursor-agent";
// The CLI marks itself non-dumpable unless this is set; OpenShell then cannot read its /proc/<pid>/exe and denies its sockets (lib/builder.mjs).
const SANDBOX_CURSOR_ENV = { CURSOR_AGENT_ALLOW_PROCESS_INSPECTION: "1" };
const GIT_TIMEOUT_MS = 120_000;

/** The OpenShell sandbox name for a project: ai-collab-<project>, lowercase, at most 40 characters of project. */
export const sandboxName = (project) => sandboxNameFor(project);

/** Argv of the ACP server: `acp`, then `--force` when the mode asks for it, then `--model` when one is named. */
export function acpArgs({ force = false, model } = {}) {
  return ["acp", ...(force ? ["--force"] : []), ...(model ? ["--model", model] : [])];
}

/**
 * Argv that runs the Cursor CLI inside a sandbox: `openshell sandbox exec` with the session's workdir, the owned
 * marker, and the CLI's home (so it reads the auth file written there) . The CLI name defaults to `cursor-agent`,
 * the name inside the sandbox image, not the host's.
 */
export function execArgv({ openshell, sandbox, args, binary = "cursor-agent", workdir, env = {} }) {
  return sandboxExecArgv({
    openshell, sandbox, workdir, command: [binary, ...args],
    env: { AI_COLLAB_OWNED: "cursor", ...env },
  });
}

export { runTool };


function forceOf(permission, place) {
  const force = permission?.force === true;
  if (force && place !== "openshell") throw new Error("cursor full-access runs only in openshell");
  return force;
}

// Bytes of the child's stderr kept for the error that ends the connection; enough for a provider's limit message.
const STDERR_TAIL_MAX = 4000;

/** An ACP JSON-RPC error as an Error that keeps the envelope's code and data (a limit or auth error carries its detail there). */
function acpError(error) {
  const out = new Error(error.message ?? "ACP error");
  // UNVERIFIED: which codes cursor-agent uses for a usage limit; the envelope is kept whole so a classifier can read it.
  if (error.code !== undefined) out.code = error.code;
  if (error.data !== undefined) out.data = error.data;
  return out;
}

/** The error for a child that exited: the exit status plus the tail of its stderr, where a startup refusal lands. */
function exitError(code, signal, stderrTail) {
  const out = new Error(`cursor-agent acp exited (${signal ?? `code ${code}`})`);
  if (code !== null && code !== undefined) out.code = code;
  if (signal) out.signal = signal;
  const tail = String(stderrTail ?? "").trim();
  if (tail) out.stderr = tail;
  return out;
}

/** Everything an error carries, as one text for the limit classifier: its message, code, data and stderr tail. */
export function errorText(error) {
  const parts = [error?.message ?? String(error ?? "")];
  if (error?.code !== undefined) parts.push(typeof error.code === "object" ? JSON.stringify(error.code) : String(error.code));
  if (error?.data !== undefined) parts.push(typeof error.data === "string" ? error.data : JSON.stringify(error.data));
  if (error?.stderr) parts.push(String(error.stderr));
  return parts.filter(Boolean).join("\n");
}

// One ACP connection: newline-delimited JSON-RPC 2.0 over the child's stdio.
function connect(argv, { env, cwd, log, onRequest, onNotify }) {
  const child = spawn(argv[0], argv.slice(1), { env, cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let dead = null;
  // The last lines the child wrote to stderr, kept for the error that ends the connection (limit text lives here).
  let stderrTail = "";
  const keepStderr = (chunk) => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX); };
  let settleExit;
  const exited = new Promise((resolve) => { settleExit = resolve; });
  // A sandbox's `exec` client is not the process holding the pipes once it is killed: the remote command inherits
  // them, so they are destroyed here or the runner never exits after a close.
  const destroyStreams = () => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) if (!stream.destroyed) stream.destroy();
  };
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) dispatch(line);
    }
  });
  child.stderr.on("data", (chunk) => { keepStderr(chunk); for (const line of chunk.split("\n")) if (line.trim()) log(line.trimEnd()); });
  child.on("error", (error) => fail(error));
  child.on("exit", (code, signal) => { fail(exitError(code, signal, stderrTail)); settleExit(); });

  function send(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  function dispatch(line) {
    let message;
    try { message = JSON.parse(line); } catch { log(`ignored non-JSON line from cursor-agent: ${line.slice(0, 200)}`); return; }
    if (message.method !== undefined && message.id !== undefined) return onRequest(message);
    if (message.method !== undefined) return onNotify(message.method, message.params ?? {});
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(acpError(message.error));
    else waiter.resolve(message.result);
  }
  function fail(error) {
    if (dead) return;
    dead = error;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  }

  return {
    pid: child.pid,
    get dead() { return dead; },
    request(method, params, timeoutMs) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs) : null;
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify: (method, params) => send({ method, params }),
    reply: (id, result) => send({ id, result }),
    replyError: (id, code, message) => send({ id, error: { code, message } }),
    kill: () => { child.kill("SIGTERM"); destroyStreams(); },
    closed: exited,
    child,
  };
}

/**
 * Uploads what a sandbox session needs and returns the exec env and workdir.
 *
 * Verified flow (docs/owned-sessions-contract.md, OpenShell): a sandbox gets no host bind mount, so the worktree
 * is uploaded before the run and downloaded after it; the CLI tree is uploaded once under SANDBOX_ROOT; auth is the
 * host's `$XDG_CONFIG_HOME/cursor/auth.json` (or `~/.config/cursor/auth.json`), written to a 0600 temp file and
 * uploaded, never passed in argv or --env, so it never reaches a log. Missing auth is not fatal: the CLI asks to log in.
 */
export async function prepareSandbox({ openshell, env, sandbox, cwd, home = homedir(), cursorTree, launcher = SANDBOX_LAUNCHER, staged = new Set(), reuseWorktree = false, log = () => {} }) {
  const remoteWork = `${SANDBOX_ROOT}/work`;
  const workdir = `${remoteWork}/${basename(cwd)}`;
  const marker = `${SANDBOX_ROOT}/.team-worktree-ready`;
  const exec = (command) => runTool(openshell, sandboxExecArgv({ openshell, sandbox, command }).slice(1), { env });
  const ready = reuseWorktree && (await exec(["test", "-f", marker])).code === 0;
  if (!ready) {
    if (existsSync(join(cwd, ".git"))) await uploadClone({ openshell, env, sandbox, cwd, remote: remoteWork });
    else await uploadTree({ openshell, env, sandbox, local: cwd, remote: remoteWork });
    if (reuseWorktree && (await exec(["touch", marker])).code !== 0) throw new Error("Could not mark team worktree ready");
  }
  const execEnv = { HOME: SANDBOX_HOME, XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config` };
  if (cursorTree) {
    // The host install tree is about 500 MB, so it is uploaded once per sandbox and reused after that; the
    // bin/ symlink is one small upload and always replaces the old target.
    if (!staged.has(sandbox)) {
      await uploadTree({ openshell, env, sandbox, local: cursorTree, remote: `${SANDBOX_ROOT}/agent` });
      staged.add(sandbox);
    }
    const dir = mkdtempSync(join(tmpdir(), "ai-collab-sandbox-bin-"));
    try {
      mkdirSync(join(dir, "bin"));
      symlinkSync(join(SANDBOX_ROOT, "agent", basename(cursorTree), launcher), join(dir, "bin", SANDBOX_LAUNCHER));
      // Its own directory (/sandbox/bin), so a second session's upload never lands on the first's.
      await uploadTree({ openshell, env, sandbox, local: join(dir, "bin"), remote: SANDBOX_ROOT });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    execEnv.PATH = `${SANDBOX_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  } else {
    // Nothing to upload: the binary must already be on the sandbox's own PATH (an image that ships it).
    log(`cursor: no CLI install tree found for ${launcher}; the sandbox's own PATH must have it`);
  }
  const authPath = [join(home, ".config", "cursor", "auth.json"), join(home, ".cursor", "auth.json")].find((p) => existsSync(p));
  if (authPath) {
    await uploadAuth({ openshell, env, sandbox, authPath, log });
  } else {
    log("cursor: no host auth.json found; the sandbox CLI will ask to log in");
  }
  return { workdir, env: execEnv };
}

// Copies the auth file in through a 0600 temp file (a single-file upload keeps the mode), then deletes the temp file.
async function uploadAuth({ openshell, env, sandbox, authPath, log }) {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-sandbox-auth-"));
  const copy = join(dir, "auth.json");
  try {
    let auth = "";
    try { auth = readFileSync(authPath, "utf8"); } catch { auth = ""; }
    if (!auth) { log("cursor: the host auth.json is unreadable; the sandbox CLI will ask to log in"); return; }
    writeFileSync(copy, auth, { mode: 0o600 });
    await uploadFile({ openshell, env, sandbox, local: copy, remoteDir: `${SANDBOX_HOME}/.config/cursor` });
  } catch (error) {
    log(`cursor: could not stage the sandbox auth file; the CLI will ask to log in (${error.message})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs git with a fixed argv; throws with its stderr on a non-zero exit.
async function git(cwd, args, env) {
  const out = await runTool("git", ["-C", cwd, ...args], { env, timeoutMs: GIT_TIMEOUT_MS });
  if (out.code !== 0) throw new Error(`git ${args[0]} failed: ${(out.stderr || "").trim() || `exit ${out.code}`}`);
  return out.stdout;
}

/**
 * Uploads a git work tree as a self-contained clone of its checked-out branch, so git works inside the sandbox:
 * a linked worktree's .git is a file pointing into the host repo, which the sandbox does not have (as lib/builder.mjs).
 */
async function uploadClone({ openshell, env, sandbox, cwd, remote }) {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-sandbox-clone-"));
  const clone = join(dir, basename(cwd));
  try {
    const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env)).trim();
    await runTool("git", ["clone", "--quiet", "--no-hardlinks", ...(branch && branch !== "HEAD" ? ["--branch", branch] : []), cwd, clone], { env, timeoutMs: GIT_TIMEOUT_MS })
      .then((out) => { if (out.code !== 0) throw new Error(`git clone failed: ${(out.stderr || "").trim()}`); });
    await git(clone, ["remote", "remove", "origin"], env);
    for (const key of ["user.name", "user.email"]) {
      const value = (await runTool("git", ["-C", cwd, "config", key], { env })).stdout.trim();
      if (value) await git(clone, ["config", key, value], env);
    }
    const out = await runTool(openshell, ["sandbox", "upload", sandbox, `${clone}/`, `${remote.replace(/\/+$/, "")}/`, "--no-git-ignore"], { env, timeoutMs: SANDBOX_TIMEOUT_MS });
    if (out.code !== 0) throw new Error(`openshell sandbox upload failed: ${(out.stderr || "").trim() || `exit ${out.code}`}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Lands a sandbox clone's work on the host work tree the way builders do: uncommitted changes become one commit, then
 * the host branch fast-forwards to it. A branch that moved on the host keeps the download and says where it is.
 */
async function landClone({ openshell, env, sandbox, cwd, log }) {
  const incoming = mkdtempSync(join(tmpdir(), "ai-collab-sandbox-back-"));
  const back = join(incoming, basename(cwd));
  let keep = false;
  try {
    await downloadTree({ openshell, env, sandbox, remote: `${SANDBOX_ROOT}/work/${basename(cwd)}`, local: back });
    if (!existsSync(join(back, ".git"))) throw new Error("the downloaded workspace has no git repository");
    if ((await git(back, ["status", "--porcelain"], env)).trim()) {
      await git(back, ["add", "-A"], env);
      await git(back, ["commit", "--quiet", "--no-verify", "-m", "chore(openshell): uncommitted work from a sandboxed session", "-m", "Assisted-by: Cursor:cursor-agent"], env);
    }
    const ahead = Number((await git(back, ["rev-list", "--count", "HEAD", "--not", (await git(cwd, ["rev-parse", "HEAD"], env)).trim()], env).catch(() => "0")).trim()) || 0;
    if (!ahead) return true;
    await git(cwd, ["fetch", "--quiet", back, "HEAD"], env);
    try {
      await git(cwd, ["merge", "--quiet", "--ff-only", "FETCH_HEAD"], env);
      log(`cursor: landed ${ahead} commit(s) from the sandbox on ${cwd}`);
    } catch (error) {
      keep = true;
      log(`cursor: could not fast-forward ${cwd}; the sandbox work is kept in ${back}: ${error.message}`);
      return false;
    }
    return true;
  } finally {
    if (!keep) rmSync(incoming, { recursive: true, force: true });
  }
}

/** Copies the sandbox worktree back to the host after a run or on close: commits for a git work tree, files otherwise; never throws. */
export async function syncSandboxBack({ openshell, env, sandbox, cwd, log = () => {} }) {
  try {
    if (existsSync(join(cwd, ".git"))) return await landClone({ openshell, env, sandbox, cwd, log });
    await downloadTree({ openshell, env, sandbox, remote: `${SANDBOX_ROOT}/work/${basename(cwd)}`, local: cwd });
    return true;
  } catch (error) {
    log(`cursor: could not copy edits back from the sandbox: ${error.message}`);
    return false;
  }
}

/** The network policy a Cursor sandbox gets when AI_COLLAB_OPENSHELL_POLICY names none: Cursor's API and the host's ntfy, for the uploaded CLI's binaries. */
export function cursorPolicy(cursorTree) {
  const inTree = `${SANDBOX_ROOT}/agent/${basename(cursorTree)}`;
  let files = [];
  try {
    files = readdirSync(cursorTree).filter((f) => { const st = statSync(join(cursorTree, f)); return st.isFile() && (st.mode & 0o111) !== 0; });
  } catch { /* no tree: the policy names no binary */ }
  return builderPolicy({ harness: "cursor", binaries: files.map((f) => `${inTree}/${f}`) });
}

// Writes cursorPolicy to a private file once per adapter and returns its path; "" without a CLI tree.
function writePolicy(cursorTree) {
  if (!cursorTree) return "";
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-cursor-policy-"));
  const file = join(dir, "policy.yaml");
  writeFileSync(file, `${JSON.stringify(cursorPolicy(cursorTree), null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Maps AG-UI output for one harness session: a run, its text and tool calls, and its approval cards. */
export default function cursorAdapter(config = {}) {
  const envOf = config.env ?? {};
  const openshellBin = envOf.AI_COLLAB_OPENSHELL_BIN || "openshell";
  // Both resolve against the caller's PATH: the service may start with a bare one.
  const lookupPath = config.path ?? envOf.PATH ?? process.env.PATH ?? "";
  const cursorBin = envOf.AI_COLLAB_CURSOR_BIN || cursorBinary(lookupPath);
  // The CLI tree uploaded into a sandbox: the version directory that holds the host binary's real path.
  const cursorTree = envOf.AI_COLLAB_CURSOR_TREE || treeOf(cursorBin, lookupPath);
  let policyPath = envOf.AI_COLLAB_OPENSHELL_POLICY || "";
  const connections = new Set();
  // One sandbox per project, reused: created by the first session and deleted when the last one closes.
  const sandboxes = new Map();
  // Sandboxes whose (large) CLI tree is already uploaded; it is only re-uploaded into a new sandbox.
  const stagedTrees = new Set();

  // Starts the ACP child (inside the sandbox for openshell) and negotiates initialize; returns the session state.
  async function attach(spec, ctx) {
    const force = forceOf(spec.permission, spec.place);
    const cursorArgs = acpArgs({ force, model: spec.model });
    const env = { ...spec.env, ...OWNED };
    let argv;
    // A claimed sandbox (and the session that holds it) is released again on any failure below.
    let sandbox = null;
    const session = { sessionId: null, run: null, approvals: new Map(), tools: new Map(), closed: false, ctx, sandbox: null, env, cwd: spec.cwd };
    try {
      if (spec.place === "openshell") {
        // One sandbox per project, reused: created by the first session and deleted when the last one closes.
        const name = spec.patternRun
          ? "team-" + createHash("sha256").update(spec.project + "/" + spec.patternRun).digest("hex").slice(0, 14)
          : sandboxName(spec.project);
        policyPath ||= writePolicy(cursorTree);
        sandbox = await ensureSandboxIn({ openshell: openshellBin, env, name, policy: policyPath });
        claim(sandbox, spec.cwd);
        session.sandbox = sandbox;
        const prepared = await prepareSandbox({
          openshell: openshellBin, env, sandbox, cwd: spec.cwd, home: spec.home, cursorTree,
          staged: stagedTrees, reuseWorktree: Boolean(spec.patternRun), log: (l) => ctx.log(l),
        });
        argv = execArgv({ openshell: openshellBin, sandbox, args: cursorArgs, workdir: prepared.workdir, env: { ...prepared.env, ...SANDBOX_CURSOR_ENV } });
        // The CLI runs in the sandbox, so it must be told the sandbox path, not the host's.
        session.remoteCwd = prepared.workdir;
      } else {
        argv = [cursorBin, ...cursorArgs];
      }
    } catch (error) {
      await closeSandbox(session);
      throw error;
    }
    const conn = connect(argv, {
      env,
      cwd: spec.place === "openshell" ? undefined : spec.cwd,
      log: (line) => ctx.log(line),
      onRequest: (message) => handleRequest(session, conn, message),
      onNotify: (method, params) => handleNotify(session, method, params),
    });
    connections.add(conn);
    ctx.signal.addEventListener("abort", () => conn.kill(), { once: true });
    // A CLI that dies on its own (crash, sandbox delete) gives up its claim too, so no sandbox is left behind.
    conn.closed.then(() => { if (session.sandbox) void closeSandbox(session); });
    try {
      const init = await conn.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT,
      }, SETUP_TIMEOUT_MS);
      if (spec.requireLoad && !init?.agentCapabilities?.loadSession) throw new Error("the Cursor CLI does not advertise loadSession; the session cannot resume");
      return { conn, session };
    } catch (error) {
      // The CLI may have died before initialize answered; closing the connection is what ends a sandbox run.
      conn.kill();
      connections.delete(conn);
      await closeSandbox(session);
      throw error;
    }
  }

  function handleRequest(session, conn, message) {
    if (message.method === "session/request_permission") return askPermission(session, conn, message);
    conn.replyError(message.id, -32601, `ai-collab does not serve ${message.method}`);
  }

  function handleNotify(session, method, params) {
    if (method !== "session/update" || !session.run) return;
    const update = params.update ?? {};
    const run = session.run;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string") run.text += update.content.text;
        return;
      case "tool_call": {
        if (typeof update.toolCallId !== "string") return;
        flushText(session, run);
        const toolCallName = update.title || update.kind || "tool";
        session.tools.set(update.toolCallId, toolCallName);
        session.ctx.emit({
          type: EventType.TOOL_CALL_CHUNK, toolCallId: update.toolCallId, toolCallName,
          delta: JSON.stringify(update.rawInput ?? {}, null, 2),
        });
        return;
      }
      case "tool_call_update": {
        if (typeof update.toolCallId !== "string" || !["completed", "failed"].includes(update.status)) return;
        const failed = update.status === "failed";
        session.ctx.emit({
          type: EventType.TOOL_CALL_RESULT, toolCallId: update.toolCallId, messageId: `${update.toolCallId}:result`, role: "tool",
          content: resultText(update, failed),
          metadata: { aiCollab: { toolCallName: session.tools.get(update.toolCallId) ?? "tool", failed } },
        });
        session.tools.delete(update.toolCallId);
        return;
      }
      default:
        return;
    }
  }

  function askPermission(session, conn, message) {
    const toolCall = message.params?.toolCall ?? {};
    const options = message.params?.options ?? [];
    const interruptId = randomUUID();
    const toolCallName = toolCall.title || toolCall.kind || "tool";
    const input = toolCall.rawInput === undefined ? "" : `: ${JSON.stringify(toolCall.rawInput).slice(0, 1000)}`;
    session.approvals.set(interruptId, { rpcId: message.id, conn, options });
    session.ctx.emit({
      type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
      value: { interruptId, reason: "tool_approval", toolCallId: toolCall.toolCallId, toolCallName, summary: `${toolCallName}${input}` },
    });
  }

  function respond(session, interruptId, decision) {
    const approval = session.approvals.get(interruptId);
    if (!approval) return;
    session.approvals.delete(interruptId);
    const allow = decision.behavior === "allow";
    const option = approval.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
    if (option) {
      approval.conn.reply(approval.rpcId, { outcome: { outcome: "selected", optionId: option.optionId } });
      session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "resolved", reason: allow ? "allowed" : "denied" } });
    } else {
      approval.conn.reply(approval.rpcId, { outcome: { outcome: "cancelled" } });
      session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "cancelled", reason: "cancelled" } });
    }
  }

  function cancelApprovals(session) {
    for (const interruptId of [...session.approvals.keys()]) respond(session, interruptId, { behavior: "deny" });
  }

  function flushText(session, run) {
    if (!run.text) return;
    session.ctx.emit({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: `${run.runId}:m${++run.messageSeq}`, role: "assistant", delta: run.text });
    run.text = "";
  }

  function endRun(session, run, outcome) {
    flushText(session, run);
    cancelApprovals(session);
    session.run = null;
    session.ctx.emit({ type: EventType.RUN_FINISHED, threadId: threadOf(session), runId: run.runId, outcome: { type: outcome } });
  }

  function failRun(session, run, error) {
    cancelApprovals(session);
    session.run = null;
    // The message carries the ACP code, data and stderr tail too, so a limit classifier sees everything the error had.
    const text = errorText(error);
    session.ctx.emit({ type: EventType.RUN_ERROR, message: text, metadata: { aiCollab: { runId: run.runId, ...(error?.code !== undefined ? { code: error.code } : {}) } } });
  }

  const threadOf = (session) => `cursor#${sessionLabel(session.sessionId)}`;

  // Counts a session's claim on its project's sandbox; the sandbox is deleted when the last claim goes.
  function claim(name, cwd) {
    const known = sandboxes.get(name) ?? { cwd, refs: 0 };
    known.refs += 1;
    sandboxes.set(name, known);
  }

  // Copies a sandbox session's edits back to the host worktree, then drops the session's claim on the sandbox;
  // the sandbox is deleted when no session holds it any more. Logs rather than throws, and runs at most once.
  function closeSandbox(session) {
    session.release ??= releaseSandbox(session);
    return session.release;
  }

  async function releaseSandbox(session) {
    const name = session.sandbox;
    session.sandbox = null;
    const log = session.ctx.log;
    if (!name) return true;
    if (session.cwd) await syncSandboxBack({ openshell: openshellBin, env: session.env, sandbox: name, cwd: session.cwd, log });
    const known = sandboxes.get(name);
    if (known) {
      known.refs = Math.max(0, (known.refs ?? 1) - 1);
      if (known.refs > 0) return true;
      sandboxes.delete(name);
    }
    const out = await destroySandbox({ openshell: openshellBin, env: session.env, name });
    stagedTrees.delete(name);
    if (!out.ok) log(`cursor: could not delete sandbox ${name}: ${out.detail}`);
    return out.ok;
  }

  function makeHandle({ conn, session }) {
    return {
      get nativeId() { return session.sessionId; },
      async send(input) {
        if (session.run) throw new Error("a cursor run is already running");
        if (conn.dead) throw conn.dead;
        const runId = randomUUID();
        const run = { runId, text: "", messageSeq: 0 };
        session.run = run;
        session.ctx.emit({
          type: EventType.RUN_STARTED, threadId: threadOf(session), runId,
          input: { threadId: threadOf(session), runId, tools: [], context: [], messages: [{ id: `${runId}:input`, role: "user", content: input.text }] },
        });
        conn.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: input.text }] }, null)
          .then((result) => endRun(session, run, result?.stopReason === "cancelled" ? "cancelled" : "success"),
            (error) => failRun(session, run, error));
        return { runId };
      },
      async interrupt() {
        if (!session.run) return;
        conn.notify("session/cancel", { sessionId: session.sessionId });
        cancelApprovals(session);
      },
      async respond(interruptId, decision) { respond(session, interruptId, decision); },
      // UNVERIFIED: session/set_model is in cursor-agent 2026.11.22's ACP dispatcher; the params follow the ACP spec. Not called live.
      async setModel(modelId) {
        if (conn.dead) throw conn.dead;
        return conn.request("session/set_model", { sessionId: session.sessionId, modelId }, TOOL_TIMEOUT_MS);
      },
      // Closing a sandbox session ends its CLI, copies its edits back, then deletes the sandbox.
      async close() {
        if (session.closed) return;
        session.closed = true;
        if (session.run) conn.notify("session/cancel", { sessionId: session.sessionId });
        cancelApprovals(session);
        conn.kill();
        connections.delete(conn);
        await closeSandbox(session);
      },
    };
  }

  return {
    harness: "cursor",
    capabilities: { steer: false, images: false, resume: "transcript", permissionModes: ["supervised", "full-access"], places: ["folder", "worktree", "openshell"] },

    async available(env = {}) {
      const out = await runTool(cursorBin, ["--version"], { env });
      return out.code === 0 ? { ok: true, detail: out.stdout.trim() } : { ok: false, detail: out.stderr.trim() || `${cursorBin} exited ${out.code}` };
    },

    async open(options, ctx) {
      const attached = await attach({ ...options, requireLoad: false }, ctx);
      try {
        const created = await attached.conn.request("session/new", { cwd: attached.session.remoteCwd ?? options.cwd, mcpServers: [] }, SETUP_TIMEOUT_MS);
        attached.session.sessionId = created.sessionId;
        return makeHandle(attached);
      } catch (error) {
        attached.conn.kill();
        connections.delete(attached.conn);
        await closeSandbox(attached.session);
        throw error;
      }
    },

    async resume(record, ctx, env) {
      const settings = permissionSettings("cursor", record.permissionMode, record.place);
      if (settings.error) throw new Error(settings.error);
      const attached = await attach({
        project: record.project, cwd: record.cwd, place: record.place, permission: settings.settings,
        model: record.model, patternRun: record.patternRun, env, requireLoad: true,
      }, ctx);
      try {
        attached.session.sessionId = record.nativeId;
        await attached.conn.request("session/load", { sessionId: record.nativeId, cwd: attached.session.remoteCwd ?? record.cwd, mcpServers: [] }, TOOL_TIMEOUT_MS);
        return makeHandle(attached);
      } catch (error) {
        attached.conn.kill();
        connections.delete(attached.conn);
        await closeSandbox(attached.session);
        throw error;
      }
    },

    // UNVERIFIED: the `--list-models` output format; lines are read as "<id>" or "<id> - <label>".
    async listModels(env = {}) {
      const out = await runTool(cursorBin, ["--list-models"], { env, timeoutMs: TOOL_TIMEOUT_MS });
      if (out.code !== 0) throw new Error(`${cursorBin} --list-models failed: ${out.stderr.trim() || `exit ${out.code}`}`);
      return out.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !/^(available|tip|loading)/i.test(l))
        .map((l) => { const [id, ...label] = l.split(/\s+-\s+/); return label.length ? { id, label: label.join(" - ") } : { id }; });
    },

    async listCommands() { return []; },

    async shutdown() {
      for (const conn of connections) conn.kill();
      connections.clear();
    },
  };
}

// The directory a Cursor CLI install lives in: `~/.local/bin/agent` is a symlink into
// `~/.local/share/cursor-agent/versions/<v>/`, which holds the CLI and its bundled node.
export function treeOf(bin, path = "") {
  if (!bin) return "";
  const found = bin.includes("/") ? bin : findExecutable(bin, path);
  if (!found) return "";
  let real = found;
  try { real = realpathSync(found); } catch { return ""; }
  const dir = dirname(real);
  // Only the real layout counts: a lone binary (a test fake, a wrapper on PATH) has no tree to upload.
  return existsSync(join(dir, "node")) ? dir : "";
}

// Text of a finished tool call: the text content blocks, else the raw output, else a status word.
function resultText(update, failed) {
  const blocks = Array.isArray(update.content) ? update.content : [];
  const text = blocks.map((b) => (b?.type === "content" && b.content?.type === "text" ? b.content.text : "")).join("");
  if (text) return text;
  if (typeof update.rawOutput === "string" && update.rawOutput) return update.rawOutput;
  return failed ? "failed" : "completed";
}
