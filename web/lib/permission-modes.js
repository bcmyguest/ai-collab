// Permission values the slash commands accept, mirrored for the browser: lib/harness.ts and runner/contract.ts pull in
// node modules. test/permission-modes.test.mjs fails when a mirror drifts from its source.

// lib/harness.ts CLAUDE_PERMISSION_VALUES, in that order: /permission and /team-permission accept these.
export const CLAUDE_PERMISSION_VALUES = ["auto-afk", "inherit", "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];

// runner/contract.ts PERMISSION_TABLE keys per harness: the modes /mode can set on a runner-owned session.
export const RUNNER_PERMISSION_MODES = {
  claude: ["supervised", "accept-edits", "auto", "full-access"],
  codex: ["supervised", "accept-edits", "auto", "full-access"],
  opencode: ["supervised", "accept-edits", "full-access"],
  cursor: ["supervised", "full-access"],
};

// runner/contract.ts CLAUDE_CLI_MODES: the Claude name the runner maps onto each runner mode.
export const CLAUDE_CLI_MODES = { default: "supervised", acceptEdits: "accept-edits", auto: "auto", bypassPermissions: "full-access" };

export const CLAUDE_PERMISSION_SUMMARIES = {
  "auto-afk": "default while AFK is on; your own Claude settings otherwise",
  inherit: "Pass no mode, so your own Claude settings apply",
  acceptEdits: "Accept file edits without asking",
  auto: "Claude's auto mode",
  bypassPermissions: "No prompts; OpenShell only, unless the host allows it",
  default: "Ask before each tool that needs permission",
  dontAsk: "Deny any tool not already allowed, without asking",
  plan: "Plan mode: read and plan, no edits",
};

export const RUNNER_MODE_SUMMARIES = {
  supervised: "Ask before each action that needs approval",
  "accept-edits": "Allow file edits, ask for the rest",
  auto: "The harness's automatic reviewer answers approvals",
  "full-access": "No approvals; OpenShell only unless the host allows it",
};
