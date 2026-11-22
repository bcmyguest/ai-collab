// The new-agent dialogue's mode pill: Agent / Ask / Plan, and the argv each harness gets for it.
// Only modes a harness documents are offered; a harness without a plan or ask mode lists neither.
// Verified read-only from the installed CLIs (`--help` and their bundles), never by running an agent:
//   claude   --permission-mode <mode>, with "plan" among the accepted modes
//   codex    -s, --sandbox read-only (a read-only sandbox: analysis and plans, no edits)
//   cursor   --mode <mode>, choices "plan" and "ask" (both read-only)
//   opencode --agent <name>; its built-in "plan" primary agent plans before implementing

/** Pill labels, in the order the menu lists them. `agent` is the normal, editing mode. */
export const MODE_LABELS = { agent: "Agent", ask: "Ask", plan: "Plan" };

/** The modes each harness starts in; "agent" needs no flag. */
export const START_MODES = {
  claude: ["agent", "plan"],
  codex: ["agent", "plan"],
  cursor: ["agent", "ask", "plan"],
  opencode: ["agent", "plan"],
};

/** Modes the harness can start in, in pill order; none for an unknown harness. */
export function startModes(harness) {
  return START_MODES[harness] || [];
}

/** Extra argv for a mode, [] for the normal mode, null when the harness has no such mode. */
export function modeFlags(harness, mode = "agent") {
  if (!mode || mode === "agent") return startModes(harness).includes("agent") ? [] : null;
  if (!startModes(harness).includes(mode)) return null;
  switch (harness) {
    case "claude": return ["--permission-mode", "plan"];
    case "codex": return ["-s", "read-only"];
    case "cursor": return ["--mode", mode];
    case "opencode": return ["--agent", "plan"];
    default: return null;
  }
}
