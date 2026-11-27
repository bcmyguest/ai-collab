// Slash commands the phone sends to a session, and what each harness supports. Shared by the server and the composer.
// Statuses: "supported" (verified in the harness source, binary or schema), "partial" (works for some session states only),
// "unverified" (documented, effect not checked), "unsupported" (no channel, or refused).

import { CLAUDE_CLI_MODES, CLAUDE_PERMISSION_SUMMARIES, CLAUDE_PERMISSION_VALUES, RUNNER_MODE_SUMMARIES, RUNNER_PERMISSION_MODES } from "./permission-modes.js";

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
// "/name word word partial": the words already typed after a command name, then the one being typed.
const TYPING_ARGS = /^\/([a-z][a-z0-9-]{0,31})\s+((?:\S+\s+)*)(\S*)$/i;

export const COMMANDS = [
  { name: "compact", summary: "Compact the context" },
  { name: "model", summary: "Switch the model", args: "<provider/model>" },
  { name: "clear", summary: "Start a new context" },
  { name: "permission", summary: "Permission mode for the next start or wake", args: "<mode>" },
  { name: "mode", summary: "Change a live session's permission mode", args: "<mode>" },
  { name: "team-permission", summary: "Permission mode for a team, after you confirm", args: "<team> <mode>" },
];

const supported = (reason) => ({ status: "supported", reason });
const partial = (reason) => ({ status: "partial", reason });
const unverified = (reason) => ({ status: "unverified", reason });
const unsupported = (reason) => ({ status: "unsupported", reason });

// "passthrough" applies to any typed /name that is not in COMMANDS.
export const SUPPORT = {
  claude: {
    compact: partial("A runner-owned session compacts in place: /compact on its live query. A terminal session compacts through the Agent SDK when saved, or gets a request to finish its step, then /compact in its terminal."),
    model: unsupported("Claude's messaging socket delivers text only; no model switch is documented."),
    permission: supported("Stored for the session's next start or wake (--permission-mode); the running turn keeps its mode."),
    mode: partial("Runner-owned sessions only: the runner changes the live session's mode (supervised, accept-edits, auto, full-access; Claude names map)."),
    "team-permission": supported("Asks the operator to Apply or Cancel on a phone card; Apply rewrites team.dot."),
    clear: unsupported("No clear is documented for Claude's messaging socket."),
    passthrough: unsupported("The socket wraps each message in a cross-session envelope, so /name reaches Claude as text, not a command."),
  },
  codex: {
    compact: partial("A runner-owned session compacts in place with thread/compact/start. A terminal session compacts the thread when it is loaded and idle in the app-server daemon, or a saved thread; otherwise it gets a request."),
    model: unsupported("app-server sets the model per turn (turn/start), not on a thread, so it cannot change the model alone."),
    clear: unsupported("thread/start creates a new thread id; this session keeps its id."),
    permission: unsupported("/permission sets Claude's permission mode; Codex has none."),
    mode: partial("Runner-owned sessions only: the runner changes the live session's mode (supervised, accept-edits, auto, full-access; Claude names map)."),
    "team-permission": supported("Asks the operator to Apply or Cancel on a phone card; Apply rewrites team.dot."),
    passthrough: unsupported("No app-server method runs a slash command. Sending it as a turn is unverified."),
  },
  opencode: {
    compact: supported("POST /api/session/{id}/compact (operation session.compact in the OpenCode binary)."),
    model: unverified("POST /api/session/{id}/model (session.switchModel). The body {providerID, modelID} is not checked against a live service."),
    clear: unsupported("POST /api/session creates another session; this one keeps its id."),
    permission: unsupported("/permission sets Claude's permission mode; OpenCode has none."),
    mode: partial("Runner-owned sessions only: the runner changes the live session's mode (supervised, accept-edits, auto, full-access; Claude names map)."),
    "team-permission": supported("Asks the operator to Apply or Cancel on a phone card; Apply rewrites team.dot."),
    passthrough: unverified("POST /api/session/{id}/command (session.command). The body {command, arguments} is not checked against a live service."),
  },
  cursor: {
    compact: unsupported("No outside compaction trigger. The Compact button sends the session a request instead."),
    model: unsupported("cursor-agent exposes no control channel for a running session (--resume and --print only)."),
    clear: unsupported("cursor-agent exposes no control channel for a running session (--resume and --print only)."),
    permission: unsupported("/permission sets Claude's permission mode; Cursor has none."),
    mode: unsupported("cursor-agent cannot change its permission mode while open."),
    "team-permission": supported("Asks the operator to Apply or Cancel on a phone card; Apply rewrites team.dot."),
    passthrough: unsupported("cursor-agent exposes no control channel for a running session (--resume and --print only)."),
  },
};

/** {name, args} for a message that starts with /name, else null. */
export function parseCommand(text) {
  const found = /^\/([a-z][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  return found ? { name: found[1].toLowerCase(), args: (found[2] || "").trim() } : null;
}

/**
 * The parsed command for a composer message, or null when the message is chat. Only a first word that names a known
 * command, or one the picker inserted (picked: a Set of names), makes it a command: "/home/x is broken" stays chat.
 */
export function commandFor(text, picked = new Set()) {
  const parsed = parseCommand(text);
  if (!parsed) return null;
  const known = COMMANDS.some(command => command.name === parsed.name);
  return known || picked.has(parsed.name) ? parsed : null;
}

/** The support entry {status, reason} for a harness and command name; unknown names use passthrough. */
export function commandSupport(harness, name) {
  const table = SUPPORT[harness];
  if (!table) return unsupported("Unknown harness.");
  return table[name] ?? table.passthrough;
}

/**
 * Entries for the composer picker: known commands whose name starts with prefix, each with its support for the harness.
 * When no known command matches a valid name, the typed name itself is offered as a passthrough command.
 */
export function matchCommands(harness, prefix) {
  const typed = prefix.toLowerCase();
  const known = COMMANDS.filter(command => command.name.startsWith(typed))
    .map(command => ({ ...command, ...commandSupport(harness, command.name) }));
  if (known.length || !NAME.test(typed)) return known;
  return [{ name: typed, summary: "Send /" + typed + " to the session", ...commandSupport(harness, typed) }];
}

const claudeValues = () => CLAUDE_PERMISSION_VALUES.map(value => ({ value, summary: CLAUDE_PERMISSION_SUMMARIES[value] }));

// The values /mode accepts for a harness: its runner modes, and for Claude the Claude names the runner maps onto them.
function modeValues(harness) {
  const modes = RUNNER_PERMISSION_MODES[harness] ?? [];
  const aliases = harness === "claude" ? Object.entries(CLAUDE_CLI_MODES).filter(([name, mode]) => name !== mode && modes.includes(mode)) : [];
  return [...modes.map(value => ({ value, summary: RUNNER_MODE_SUMMARIES[value] })),
    ...aliases.map(([value, mode]) => ({ value, summary: "Claude's name for " + mode }))];
}

// The values for argument index of a command: teams [{name, description?}] and models [id] come from the composer's data.
function argValues(name, index, harness, { teams = [], models = [] }) {
  switch (name + ":" + index) {
    case "permission:0": return claudeValues();
    case "mode:0": return modeValues(harness);
    case "team-permission:0": return teams.map(team => ({ value: team.name, summary: team.description || "" }));
    case "team-permission:1": return claudeValues();
    case "model:0": return models.map(value => ({ value, summary: "" }));
    default: return [];
  }
}

/**
 * Suggestions for the argument being typed after a known command, or null when text is not "/command " plus arguments.
 * {command, options}: command is the entry with its support for the harness; options are {value, summary, text}, where
 * text is the draft with the value inserted. An unsupported command, or one with every argument typed, has no options.
 */
export function matchArgs(harness, text, data = {}) {
  const found = TYPING_ARGS.exec(text);
  const known = found && COMMANDS.find(command => command.name === found[1].toLowerCase());
  if (!known?.args) return null;
  const command = { ...known, ...commandSupport(harness, known.name) };
  const done = found[2].trim() ? found[2].trim().split(/\s+/) : [];
  const slots = known.args.split(" ").length;
  if (command.status === "unsupported" || done.length >= slots) return { command, options: [] };
  const typed = found[3];
  const head = text.slice(0, text.length - typed.length);
  const tail = done.length < slots - 1 ? " " : "";
  const options = argValues(known.name, done.length, harness, data)
    .filter(option => option.value.toLowerCase().startsWith(typed.toLowerCase()))
    .map(option => ({ ...option, text: head + option.value + tail }));
  // A value typed in full needs no suggestion.
  if (options.length === 1 && options[0].value === typed) return { command, options: [] };
  return { command, options };
}
