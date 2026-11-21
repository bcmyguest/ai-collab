/**
 * Shell/CLI front end. runCli returns an exit code and never calls process.exit,
 * so tests can drive it with fake stdio.
 */
import { loadConfig } from "./config.mjs";
import { claimInbox, readStatuses, sendMessage } from "./inbox.mjs";
import { formatInbox } from "./format.mjs";
import { sendReceipts, settleReceipts } from "./receipts.mjs";
import { MODES, currentMode, operatorConfigs, publishMode } from "./mode.mjs";
import { agentDirectory, sessionDirectory, setIdentity } from "./sessions.mjs";
import { respond, sendAndAwait, waitForMessages } from "./agents.mjs";
import { setup } from "./setup.mjs";

export const USAGE = `usage: ai-collab <command>
  setup [--port N] [--no-ui]  start ntfy in Docker, install plugins for every harness on PATH and the UI service
  peers                       list AI_COLLAB_PEERS with the last status each reported
  send <peer|peer#session|all> [message] [--file /abs/image.png] [--urgent] [--await SECONDS]
                              send one message (or pipe the body on stdin), optionally with an image;
                              --urgent delivers at the recipient's next hook, --await waits for its answer
  inbox [--peek]              show new messages and mark them read (--peek leaves them unread)
  wait [SECONDS]              block up to SECONDS (default 25, max 45) for a new message, then show it
  respond <id> <working|reply|done|declined> [message]
                              answer a message by id
  identity [--name N] [--activity TEXT] [--tag T]...
                              set this session's name, activity line and tags for agents (no flags: show them)
  agents [--all]              live sessions with their identity (--all includes offline ones)
  sessions                    sessions on this machine: address, harness, online, last active, parent, cwd, resume command
  afk [on|off|quiet]          set the operator AFK mode in every project in projects.json (no argument: show it)
  help

Required: AI_COLLAB_PROJECT, AI_COLLAB_PEER. Optional: AI_COLLAB_URL (default http://127.0.0.1:8794),
AI_COLLAB_TOKEN, AI_COLLAB_PEERS. See README.md.`;

// Reads a piped body. Gives up after 2s so an open-but-silent stdin cannot hang the CLI.
function readStdinDefault(limitMs = 2000) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), limitMs);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

async function afk([mode, ...extra], { env, out, err, now }) {
  const cfgs = operatorConfigs(env);
  if (!cfgs.length) {
    err.write("ai-collab: afk: no enabled project in projects.json or the environment\n");
    return 2;
  }
  if (mode === undefined) {
    for (const cfg of cfgs) out.write(`${cfg.project}\t${(await currentMode(cfg)).mode}\n`);
    return 0;
  }
  if (!MODES.includes(mode) || extra.length) {
    err.write(`ai-collab: usage: afk ${MODES.join("|")}\n`);
    return 1;
  }
  const results = await publishMode(cfgs, mode, now ? { now: now() } : {});
  for (const r of results) out.write(r.ok ? `afk ${mode}: ${r.project}\n` : "");
  for (const r of results) if (!r.ok) err.write(`ai-collab: afk ${mode}: ${r.project}: ${r.error}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

// Live and recent sessions of this project on this machine; needs only the project, not a peer name.
function sessions(env, { out, err }) {
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: env.AI_COLLAB_PEER || "operator" });
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  const list = sessionDirectory(cfg);
  if (!list.length) out.write("no sessions recorded on this machine\n");
  for (const s of list) {
    out.write(`${s.address}\t${s.harness}\t${s.online ? "online" : "offline"}\tactive ${s.lastActive || "?"}\t${s.parent ? `parent ${s.parent}` : "-"}\t${s.cwd}${s.resume ? `\t${s.resume}` : ""}\n`);
  }
  return 0;
}

/** Splits argv into flags (spec: name → arity 0, 1, or "many") and words; flags.bad marks a missing value. */
function parseFlags(argv, spec) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arity = spec[argv[i]];
    if (arity === undefined) { words.push(argv[i]); continue; }
    if (arity === 0) { flags[argv[i]] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) { flags.bad = true; break; }
    if (arity === "many") (flags[argv[i]] ||= []).push(value);
    else flags[argv[i]] = value;
    i += 1;
  }
  return { flags, words };
}

// Live sessions with their set_identity fields; needs only the project, like sessions.
function agents(env, rest, { out, err }) {
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: env.AI_COLLAB_PEER || "operator" });
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  const list = agentDirectory(cfg, { all: rest.includes("--all") });
  if (!list.length) out.write("no live sessions recorded on this machine\n");
  for (const a of list) {
    out.write(`${a.address}\t${a.harness}\t${a.online ? "online" : "offline"}\tactive ${a.lastActive || "?"}\t${a.name || "-"}\t${a.activity || "-"}\t${(a.tags || []).join(",") || "-"}${a.parent ? `\tparent ${a.parent}` : ""}\n`);
  }
  return 0;
}

export async function runCli(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const [cmd = "help", ...rest] = argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    out.write(`${USAGE}\n`);
    return 0;
  }

  if (cmd === "setup") return setup(rest, { env, out });
  if (cmd === "afk") return afk(rest, { env, out, err, now: io.now });
  if (cmd === "sessions") return sessions(env, { out, err });
  if (cmd === "agents") return agents(env, rest, { out, err });

  const cfg = loadConfig(env);
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  if (cfg.peers.length && !cfg.peers.includes(cfg.peer)) {
    err.write(`ai-collab: warning: ${cfg.peer} is not listed in AI_COLLAB_PEERS\n`);
  }

  try {
    if (cmd === "peers") {
      const statuses = await readStatuses(cfg);
      const names = [...new Set([...cfg.peers, ...statuses.keys()])];
      if (!names.length) out.write("no peers listed (set AI_COLLAB_PEERS)\n");
      for (const name of names) {
        const s = statuses.get(name);
        const label = name === cfg.peer ? `${name} (you)` : name;
        out.write(`${label}\t${s ? `${s.event} ${s.harness} ${s.ts}` : "no status seen"}\n`);
      }
      return 0;
    }

    if (cmd === "send") {
      const { flags, words: [target, ...words] } = parseFlags(rest, { "--file": 1, "--await": 1, "--urgent": 0 });
      const attachment = flags["--file"];
      const awaitSeconds = flags["--await"] === undefined ? 0 : Number(flags["--await"]);
      if (!target || flags.bad) {
        err.write("ai-collab: usage: send <peer|all> [message] [--file /abs/image.png] [--urgent] [--await SECONDS]\n");
        return 1;
      }
      let body = words.join(" ");
      if (!body) body = ((await (io.readStdin || readStdinDefault)()) || "").trim();
      const urgent = flags["--urgent"] === true;
      if (!awaitSeconds) {
        await sendMessage(cfg, target, body, { attachment, urgent });
        out.write(`sent to ${target}\n`);
        return 0;
      }
      const sent = await sendAndAwait(cfg, target, body, { awaitSeconds, attachment, urgent });
      out.write(`sent to ${sent.to}${sent.id ? ` (id ${sent.id})` : ""}\n`);
      if (sent.reply) out.write(`${formatInbox([sent.reply, ...sent.messages])}\n`);
      else out.write("no reply yet\n");
      return 0;
    }

    if (cmd === "wait") {
      const seconds = rest[0] === undefined ? 25 : Number(rest[0]);
      const got = await waitForMessages(cfg, { seconds });
      out.write(got.messages.length ? `${formatInbox(got.messages)}\n` : "no new messages\n");
      return 0;
    }

    if (cmd === "respond") {
      const [id, state, ...words] = rest;
      if (!id || !state) {
        err.write("ai-collab: usage: respond <id> <working|reply|done|declined> [message]\n");
        return 1;
      }
      let body = words.join(" ");
      if (!body) body = ((await (io.readStdin || readStdinDefault)()) || "").trim();
      const r = await respond(cfg, id, state, body);
      out.write(`${r.state} sent to ${r.to}\n`);
      return 0;
    }

    if (cmd === "identity") {
      const { flags, words } = parseFlags(rest, { "--name": 1, "--activity": 1, "--tag": "many" });
      if (flags.bad || words.length) {
        err.write("ai-collab: usage: identity [--name N] [--activity TEXT] [--tag T]...\n");
        return 1;
      }
      const own = agentDirectory(cfg, { all: true }).find((a) => a.address === `${cfg.peer}#${cfg.session}`);
      const identity = Object.keys(flags).length
        ? await setIdentity(cfg, { name: flags["--name"], activity: flags["--activity"], tags: flags["--tag"] })
        : own || {};
      out.write(`${JSON.stringify(identity)}\n`);
      return 0;
    }

    if (cmd === "inbox") {
      const peek = rest.includes("--peek");
      const messages = await claimInbox(cfg, { commit: !peek, strict: true });
      sendReceipts(cfg, messages.map((m) => m.id));
      await settleReceipts();
      out.write(messages.length ? `${formatInbox(messages)}\n` : "no new messages\n");
      return 0;
    }

    err.write(`ai-collab: unknown command "${cmd}"\n${USAGE}\n`);
    return 1;
  } catch (e) {
    err.write(`ai-collab: ${e.message}\n`);
    return 1;
  }
}
