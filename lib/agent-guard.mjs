// Refuses to run an agent harness with its approvals or sandbox off on the host; inside an OpenShell sandbox that is the boundary.
import { basename } from "node:path";
import { harnessOfBinary } from "./harness.ts";

/** Set to "1" to let one process run an unsandboxed agent harness with approvals off on the host. */
export const ALLOW_HOST_AGENT_ENV = "AI_COLLAB_ALLOW_HOST_AGENT";
// Flags that turn a harness's approvals or own sandbox off, per harness (each CLI's --help, 2026-11-22).
const UNSAFE_FLAGS = {
  cursor: ["--force", "-f", "--yolo"],
  claude: ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto"],
  opencode: ["--auto", "--dangerously-skip-permissions"],
};
// Flag-value pairs that do the same: [flag, value].
const UNSAFE_VALUES = {
  cursor: [["--sandbox", "disabled"]],
  claude: [["--permission-mode", "bypassPermissions"]],
  codex: [["--sandbox", "danger-full-access"], ["-s", "danger-full-access"]],
  opencode: [],
};
// Codex's hook-trust flag only lets plugin hooks run (lib/harness.ts CODEX_HOOK_TRUST); approvals stay on.
const SAFE_DANGEROUS = new Set(["--dangerously-bypass-hook-trust"]);

/** The harness an argv runs (by its binary's name), or "" for any other program. */
export function agentHarness(argv) {
  return Array.isArray(argv) && typeof argv[0] === "string" ? harnessOfBinary(basename(argv[0])) || "" : "";
}

/** The flags in a harness argv that turn its approvals or sandbox off; [] for a safe argv or a non-harness program. */
export function unsafeAgentFlags(argv) {
  const harness = agentHarness(argv);
  if (!harness) return [];
  const args = argv.slice(1).filter((arg) => typeof arg === "string");
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, joined] = args[i].includes("=") ? [args[i].slice(0, args[i].indexOf("=")), args[i].slice(args[i].indexOf("=") + 1)] : [args[i], undefined];
    if (UNSAFE_FLAGS[harness].includes(flag) && joined === undefined) found.push(flag);
    else if (flag.startsWith("--dangerously-") && !SAFE_DANGEROUS.has(flag)) found.push(flag);
    const value = joined ?? args[i + 1];
    if (UNSAFE_VALUES[harness].some(([f, v]) => f === flag && v === value)) found.push(`${flag} ${value}`);
  }
  return found;
}

/**
 * Why argv may not run here, or "" when it may: a harness with approvals off runs only inside a sandbox, unless
 * AI_COLLAB_ALLOW_HOST_AGENT=1 is set in the caller's environment.
 */
export function hostAgentRefusal(argv, { sandboxed = false, env = process.env } = {}) {
  if (sandboxed || env[ALLOW_HOST_AGENT_ENV] === "1") return "";
  const flags = unsafeAgentFlags(argv);
  if (!flags.length) return "";
  return `refused to run ${agentHarness(argv)} with ${flags.join(", ")} on the host: run it in an OpenShell sandbox (schedules.json "sandbox": true, place "openshell") or set ${ALLOW_HOST_AGENT_ENV}=1`;
}

/** Throws an Error with code "EHOSTAGENT" when hostAgentRefusal refuses argv. */
export function assertHostAgent(argv, options) {
  const refusal = hostAgentRefusal(argv, options);
  if (refusal) throw Object.assign(new Error(refusal), { code: "EHOSTAGENT" });
}
