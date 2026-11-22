/**
 * Shell/CLI front end. runCli returns an exit code and never calls process.exit,
 * so tests can drive it with fake stdio.
 */
import { loadConfig } from "./config.mjs";
import { HISTORY_DEFAULT, HISTORY_MAX, channelHistory, claimInbox, readStatuses, sendMessage } from "./inbox.mjs";
import { formatHistory, formatInbox, formatMessageLine } from "./format.mjs";
import { sendReceipts, settleReceipts } from "./receipts.mjs";
import { MODES, currentMode, operatorConfigs, publishMode, storedMode } from "./mode.mjs";
import { agentDirectory, listSessions, sessionDirectory, setIdentity } from "./sessions.mjs";
import { respond, sendAndAwait, waitForIdle, waitForMessages, waitForReply } from "./agents.mjs";
import { interruptSession } from "./interrupt.mjs";
import { setup } from "./setup.mjs";
import { createTeam, deleteTeam, listTeams, teamStart, teamStatus } from "./teams.mjs";
import { listModels } from "./models.mjs";
import { pattern } from "./pattern-cli.mjs";
import { task } from "./task-cli.mjs";
import { mission } from "./mission-cli.mjs";
import { job } from "./job.mjs";
import { builder } from "./builder.mjs";
import { recordOwnerProgress } from "./tasks.mjs";

export const USAGE = `usage: ai-collab <command>
  setup [--agent claude,codex,cursor,opencode] [--port N] [--no-ui]
                              start ntfy in Docker, install the plugin for each agent (default: every one on PATH) and the UI service
  peers                       list AI_COLLAB_PEERS with the last status each reported
  send <peer|peer#session|all> [message] [--file /abs/image.png] [--urgent] [--priority normal|urgent|fyi] [--expect-reply] [--await SECONDS] [--reply-to ID] [--progress]
                              send one message (or pipe the body on stdin), optionally with an image;
                              --urgent delivers at the recipient's next hook, --priority fyi queues without waking an idle agent,
                              --expect-reply redelivers until the target answers, --await waits for its answer
  inbox [--peek]              show new messages and mark them read (--peek leaves them unread)
  history [--limit N]         show the last N project-channel messages, oldest first (default 30, max 100); read-only
  wait [SECONDS]              block up to SECONDS (default 25, max 45) for a new message, then show it
  wait idle:<peer#session> [SECONDS]
                              block until that agent has no turn running (or its session ended)
  wait reply:<id> [SECONDS]   block until a reply, done or declined answer to message id arrives
  interrupt <peer#session>    interrupt the running turn of a Codex or OpenCode session
  respond <id> <working|reply|done|declined> [message]
                              answer a message by id
  identity [--name N] [--activity TEXT] [--tag T]...
                              set this session's name, activity line and tags for agents (no flags: show them)
  agents [--all] [--tag T]... live sessions with their identity (--all includes offline ones; --tag keeps sessions with every tag)
  job run -- <command> [args...]
                              run a command and report it as active work for this session
  sessions                    sessions on this machine: address, harness, online, last active, parent, cwd, resume command
  afk [on|off|quiet|park]     set or show AFK mode, or park the terminal until Space switches it off
  team list                   list teams for this project (global teams.json merged; project overrides)
  team create <name> <member>...
                              create or replace a project team (members are harness or harness:model)
  team delete <name>          delete a project team (not a global one)
  team start <name> <member> "<task>"
                              start one team member with its task and record its session
  team status <name>          show each member's session address and whether it is online
  pattern list                list patterns (built-in, global, project, and teams as one-role-per-member patterns)
  pattern show <name>         print a pattern as JSON
  pattern create <file | ->   save a project pattern from JSON (roles, handoffs with required flags)
  pattern delete <name>       delete a project pattern
  pattern start <name> "<task>"
                              start a run: the entry role's session gets the task
  pattern runs                list runs for this project
  pattern status <run-id>     show a run's active role and handoff log
  pattern advance <run-id> "<event>" ["note"]
                              take the active role's handoff named by event, and message or start the next role
  task list [status]          list project tasks by priority: id, status, priority, owner, run, title
  task show <id>              print a task as JSON
  task add "<title>"          add an open task; --priority P0|P1|P2|P3 (default P2)
  task set <id> status=<s>    set status (open, decided, building, blocked, done); also title=, detail=, priority=
  task block <id> <blocker>   record that the task waits on another task
  task progress <id> "<text>" append a progress line
  task own <id> <address>     set the owning session (e.g. claude#0123456789abcdef)
  task remove <id>            delete a task no other task is blocked on
  task render                 rewrite docs/feature-requests.md from the task store
  task import <file.md>       one-time import of a feature-requests table into the store
  task help                   print every task command; any command also takes --help
  mission show                print MISSION.md as JSON, or say there is none
  mission check               report whether MISSION.md parses, with its counts
  mission add-goal "<text>"   add an open goal to MISSION.md
  mission done-goal <n>       check goal n (1-based) as done
  mission open-goal <n>       uncheck goal n
  mission remove-goal <n>     delete goal n
  mission add-rule "<text>"   add a rule to MISSION.md
  mission remove-rule <n>     delete rule n
  mission help                print every mission command; any command also takes --help
  builder start --task <id> [--harness cursor|codex|claude] [--model M] --brief <file> [--branch B]
                              start a builder in its own OpenShell sandbox, detached in unit builder-<id> (docs/builders.md)
  builder list [--all]        live builders: unit, task, sandbox, phase, unit state
  builder stop <id>           stop a builder's unit and delete its sandbox
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

function waitForLocalKey(input) {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    const finish = (local, error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      if (!wasFlowing) input.pause();
      try {
        input.setRawMode(wasRaw);
      } catch (restoreError) {
        reject(error ?? restoreError);
        return;
      }
      if (error) reject(error);
      else resolve(local);
    };
    const onData = (chunk) => {
      const key = String(chunk);
      if (key === " ") finish(true);
      if (key === "\x03") finish(false);
    };
    const onEnd = () => finish(false);
    const onError = (error) => finish(false, error);

    input.setRawMode(true);
    input.once("end", onEnd);
    input.once("error", onError);
    input.on("data", onData);
    input.resume();
  });
}

async function afk([mode, ...extra], { env, out, err, now, input }) {
  const cfgs = operatorConfigs(env);
  if (!cfgs.length) {
    err.write("ai-collab: afk: no enabled project in projects.json or the environment\n");
    return 2;
  }
  if (mode === undefined) {
    for (const cfg of cfgs) out.write(`${cfg.project}\t${(await currentMode(cfg)).mode}\n`);
    return 0;
  }
  if (extra.length || (!MODES.includes(mode) && mode !== "park")) {
    err.write(`ai-collab: usage: afk ${MODES.join("|")}|park\n`);
    return 1;
  }
  if (mode === "park") {
    if (!input.isTTY || !out.isTTY) {
      err.write("ai-collab: afk park requires an interactive terminal\n");
      return 1;
    }
    out.write("Press Space to switch to local control, or Ctrl-C to close.\n");
    if (!await waitForLocalKey(input)) return 130;
    mode = "off";
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
    out.write(`${s.address}\t${s.harness}\t${s.online ? "online" : "offline"}\tactive ${s.lastActive || "?"}${s.runningJobs ? `\tjobs ${s.runningJobs}` : ""}\t${s.parent ? `parent ${s.parent}` : "-"}\t${s.cwd}${s.resume ? `\t${s.resume}` : ""}\n`);
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
function agents(env, argv, { out, err }) {
  const { flags } = parseFlags(argv, { "--all": 0, "--tag": "many" });
  if (flags.bad) {
    err.write("ai-collab: usage: agents [--all] [--tag T]...\n");
    return 1;
  }
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: env.AI_COLLAB_PEER || "operator" });
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  const list = agentDirectory(cfg, { all: flags["--all"] === true, tags: flags["--tag"] || [] });
  if (!list.length) out.write("no live sessions recorded on this machine\n");
  for (const a of list) {
    out.write(`${a.address}\t${a.harness}\t${a.online ? "online" : "offline"}\tactive ${a.lastActive || "?"}${a.runningJobs ? `\tjobs ${a.runningJobs}` : ""}\t${a.name || "-"}\t${a.activity || "-"}\t${(a.tags || []).join(",") || "-"}${a.parent ? `\tparent ${a.parent}` : ""}\n`);
  }
  return 0;
}

// Interrupts a Codex or OpenCode session's running turn; needs only the project.
async function interrupt([address, ...extra], env, { out, err }) {
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: env.AI_COLLAB_PEER || "operator" });
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  if (!address || extra.length) {
    err.write("ai-collab: usage: interrupt <peer#session>\n");
    return 1;
  }
  const session = listSessions(cfg).find((s) => s.id === address);
  if (!session) {
    err.write("ai-collab: unknown session\n");
    return 1;
  }
  const r = await interruptSession(session);
  out.write(`${r.status}\t${r.detail}\n`);
  return r.status === "succeeded" ? 0 : 1;
}

async function team([sub, ...rest], { env, cfg, out, err, io }) {
  if (!cfg.enabled) {
    err.write(`ai-collab: disabled: ${cfg.reason}\n`);
    return 2;
  }
  const models = () => listModels(cfg.stateDir, env, { peers: cfg.peers });
  try {
    if (sub === "list" || sub === undefined) {
      if (rest.length) { err.write("ai-collab: usage: team list\n"); return 1; }
      const teams = listTeams(cfg, env);
      const names = Object.keys(teams).sort();
      if (!names.length) out.write("no teams configured\n");
      for (const name of names) out.write(`${name}\t${teams[name].join(", ")}\n`);
      return 0;
    }
    if (sub === "create") {
      const [name, ...members] = rest;
      if (!name || !members.length) {
        err.write("ai-collab: usage: team create <name> <member>...\n");
        return 1;
      }
      const created = await createTeam(cfg, name, members, env, await models());
      out.write(`team ${created.name}: ${created.members.join(", ")}\n`);
      return 0;
    }
    if (sub === "delete") {
      const [name] = rest;
      if (!name || rest.length > 1) { err.write("ai-collab: usage: team delete <name>\n"); return 1; }
      const removed = deleteTeam(cfg, name, env);
      out.write(`deleted ${removed.deleted}\n`);
      return 0;
    }
    if (sub === "status") {
      const [name] = rest;
      if (!name || rest.length > 1) { err.write("ai-collab: usage: team status <name>\n"); return 1; }
      for (const row of teamStatus(cfg, name, env)) {
        out.write(`${row.member}\t${row.address || "-"}\t${row.online ? "online" : "offline"}\n`);
      }
      return 0;
    }
    if (sub === "start") {
      const [name, member, ...words] = rest;
      let task = words.join(" ");
      if (!name || !member) { err.write("ai-collab: usage: team start <name> <member> \"<task>\"\n"); return 1; }
      if (!task) task = ((await (io.readStdin || readStdinDefault)()) || "").trim();
      if (!task) { err.write("ai-collab: team start: missing task\n"); return 1; }
      const result = await teamStart(cfg, name, member, task, env, { models: await models() });
      out.write(`${result.member}\t${result.status}\t${result.session || "-"}\t${result.detail || ""}\n`);
      return result.status === "failed" ? 1 : 0;
    }
    err.write(`ai-collab: unknown team command "${sub}"\n`);
    return 1;
  } catch (e) {
    err.write(`ai-collab: team: ${e.message}\n`);
    return 1;
  }
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
  if (cmd === "afk") return afk(rest, { env, out, err, now: io.now, input: io.stdin || process.stdin });
  if (cmd === "sessions") return sessions(env, { out, err });
  if (cmd === "agents") return agents(env, rest, { out, err });
  if (cmd === "interrupt") return interrupt(rest, env, { out, err });
  if (cmd === "team") return team(rest, { env, cfg: loadConfig(env), out, err, io });
  if (cmd === "pattern") return pattern(rest, { env, cfg: loadConfig(env), out, err, io });
  if (cmd === "task") return task(rest, { env, cfg: loadConfig(env), out, err });
  if (cmd === "mission") return mission(rest, { env, cfg: loadConfig(env), out, err });
  if (cmd === "job") return job(rest, { env, cfg: loadConfig(env), out, err, registered: (cfg, address) => listSessions(cfg).some(s => s.id === address) });
  if (cmd === "builder") return builder(rest, { env, cfg: loadConfig(env), out, err });

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
      const { flags, words: [target, ...words] } = parseFlags(rest, { "--file": 1, "--await": 1, "--urgent": 0, "--priority": 1, "--expect-reply": 0, "--reply-to": 1, "--progress": 0 });
      const attachment = flags["--file"];
      const awaitSeconds = flags["--await"] === undefined ? 0 : Number(flags["--await"]);
      const replyTo = flags["--reply-to"];
      // An unknown --flag would otherwise become message text.
      const unknown = words.find((word) => /^--[a-z][a-z-]*$/.test(word));
      if (!target || flags.bad || unknown || (replyTo !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(replyTo)) || (flags["--progress"] && target !== "all")) {
        if (unknown) err.write(`ai-collab: unknown option ${unknown}\n`);
        err.write("ai-collab: usage: send <peer|all> [message] [--file /abs/image.png] [--urgent] [--priority normal|urgent|fyi] [--expect-reply] [--await SECONDS] [--reply-to ID] [--progress (all only)]\n");
        return 1;
      }
      let body = words.join(" ");
      if (!body) body = ((await (io.readStdin || readStdinDefault)()) || "").trim();
      const urgent = flags["--urgent"] === true;
      const priority = flags["--priority"];
      const expectReply = flags["--expect-reply"] === true ? true : undefined;
      if (flags["--progress"] && storedMode(cfg).mode === "quiet") {
        out.write("not sent: AFK mode is QUIET, progress posts are dropped\n");
        return 0;
      }
      if (!awaitSeconds) {
        await sendMessage(cfg, target, body, { attachment, urgent, priority, expectReply, ...(replyTo ? { replyTo } : {}) });
        out.write(`sent to ${target}\n`);
        if (flags["--progress"]) await Promise.resolve().then(() => recordOwnerProgress(cfg, body, env)).catch((error) => err.write(`ai-collab: task progress not recorded: ${error.message}\n`));
        return 0;
      }
      const sent = await sendAndAwait(cfg, target, body, { awaitSeconds, attachment, urgent, priority, expectReply, ...(replyTo ? { replyTo } : {}) });
      out.write(`sent to ${sent.to}${sent.id ? ` (id ${sent.id})` : ""}\n`);
      if (sent.reply) out.write(`${formatInbox([sent.reply, ...sent.messages])}\n`);
      else out.write("no reply yet\n");
      return 0;
    }

    if (cmd === "wait" && rest[0]?.startsWith("idle:")) {
      const done = await waitForIdle(cfg, rest[0].slice(5), { seconds: rest[1] === undefined ? 25 : Number(rest[1]) });
      out.write(`${done.status}\t${done.address}\n`);
      return 0;
    }

    if (cmd === "wait" && rest[0]?.startsWith("reply:")) {
      const id = rest[0].slice(6);
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) {
        err.write("ai-collab: usage: wait reply:<message id> [SECONDS]\n");
        return 1;
      }
      const got = await waitForReply(cfg, id, { awaitSeconds: rest[1] === undefined ? 25 : Number(rest[1]) });
      if (got.status !== "replied") {
        out.write("no reply yet\n");
        return 1;
      }
      out.write(`${formatMessageLine(got.reply)}\n`);
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

    if (cmd === "history") {
      const { flags, words } = parseFlags(rest, { "--limit": 1 });
      const limit = flags["--limit"] === undefined ? HISTORY_DEFAULT : Number(flags["--limit"]);
      if (flags.bad || words.length || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX) {
        err.write(`ai-collab: usage: history [--limit N] (1-${HISTORY_MAX}, default ${HISTORY_DEFAULT})\n`);
        return 1;
      }
      const messages = await channelHistory(cfg, { limit });
      out.write(messages.length ? `${formatHistory(messages)}\n` : "no messages on the project channel\n");
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
