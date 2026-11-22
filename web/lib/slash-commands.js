// Slash commands the phone sends to a session, and what each harness supports. Shared by the server and the composer.
// Statuses: "supported" (verified in the harness source or binary), "unverified" (documented, effect not checked), "unsupported".

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const COMMANDS = [
  { name: "compact", summary: "Compact the context" },
  { name: "model", summary: "Switch the model", args: "<provider/model>" },
  { name: "clear", summary: "Start a new context" },
];

const supported = (reason) => ({ status: "supported", reason });
const unverified = (reason) => ({ status: "unverified", reason });
const unsupported = (reason) => ({ status: "unsupported", reason });

// "passthrough" applies to any typed /name that is not in COMMANDS.
export const SUPPORT = {
  claude: {
    compact: supported("Compacts a saved session through the Agent SDK. A running session gets a request to finish its step, then /compact in its terminal."),
    model: unsupported("Claude's messaging socket delivers text only; no model switch is documented."),
    clear: unsupported("No clear is documented for Claude's messaging socket."),
    passthrough: unsupported("The socket wraps each message in a cross-session envelope, so /name reaches Claude as text, not a command."),
  },
  codex: {
    compact: supported("Compacts the thread with thread/compact/start on the app-server daemon when idle, or a saved thread."),
    model: unsupported("app-server sets the model per turn (turn/start), not on a thread, so it cannot change the model alone."),
    clear: unsupported("thread/start creates a new thread id; this session keeps its id."),
    passthrough: unsupported("No app-server method runs a slash command. Sending it as a turn is unverified."),
  },
  opencode: {
    compact: supported("POST /api/session/{id}/compact (operation session.compact in the OpenCode binary)."),
    model: unverified("POST /api/session/{id}/model (session.switchModel). The body {providerID, modelID} is not checked against a live service."),
    clear: unsupported("POST /api/session creates another session; this one keeps its id."),
    passthrough: unverified("POST /api/session/{id}/command (session.command). The body {command, arguments} is not checked against a live service."),
  },
  cursor: {
    compact: unsupported("No outside compaction trigger. The Compact button sends the session a request instead."),
    model: unsupported("cursor-agent exposes no control channel for a running session (--resume and --print only)."),
    clear: unsupported("cursor-agent exposes no control channel for a running session (--resume and --print only)."),
    passthrough: unsupported("cursor-agent exposes no control channel for a running session (--resume and --print only)."),
  },
};

/** {name, args} for a message that starts with /name, else null. */
export function parseCommand(text) {
  const found = /^\/([a-z][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  return found ? { name: found[1].toLowerCase(), args: (found[2] || "").trim() } : null;
}

/** The support entry {status, reason} for a harness and command name; unknown names use passthrough. */
export function commandSupport(harness, name) {
  const table = SUPPORT[harness];
  if (!table) return unsupported("Unknown harness.");
  return table[name] ?? table.passthrough;
}

/** Known commands whose name starts with prefix, each with its support for the harness. */
export function matchCommands(harness, prefix) {
  const typed = prefix.toLowerCase();
  return COMMANDS.filter(command => command.name.startsWith(typed))
    .map(command => ({ ...command, ...commandSupport(harness, command.name) }));
}
