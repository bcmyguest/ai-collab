// A team graph plus a list of outcomes (edge labels) is the step log. decide owns the cap,
// required-edge, and done rules. This walk only records enter, event, and leave.
import { commitDecided, decide } from "./pattern-runs.mjs";

type Role = { id: string; count?: number };
export type TraceDefinition = { name: string; roles: Role[]; [key: string]: unknown };
type Token = { role: string; index: number };
export type TraceOutcome = string | { event: string; role: string; index: number };
export type TraceStep = { step: "enter" | "event" | "leave" | "done"; role?: string; index?: number; event?: string; refused?: string; kind?: string; to?: string };
export type Trace = { status: string; reason?: string; active: string; steps: TraceStep[] };
type TraceRun = {
  id: string; pattern: string; definition: TraceDefinition; task: string; status: string; active: string; live: Token[];
  sessions: Record<string, string>; instances: Record<string, string[]>; arrivals: Record<string, unknown>; visits: Record<string, number[]>;
  handoffs: unknown[]; notes: string[]; error?: string;
};

const countOf = (role: Role) => role.count ?? 1;

/** The run shape decide reads, with one stand-in session per instance so a trace needs no harness. */
function traceRun(definition: TraceDefinition): TraceRun {
  const entry = definition.roles[0];
  const instances: Record<string, string[]> = {};
  const sessions: Record<string, string> = {};
  for (const role of definition.roles) {
    const count = countOf(role);
    instances[role.id] = Array.from({ length: count }, (_, index) => `${role.id}#${index}`);
    sessions[role.id] = instances[role.id][0];
  }
  return {
    id: "trace", pattern: definition.name, definition, task: "", status: "running", active: entry.id,
    live: Array.from({ length: countOf(entry) }, (_, index) => ({ role: entry.id, index })),
    sessions, instances, arrivals: {}, visits: { [entry.id]: Array.from({ length: countOf(entry) }, () => 1) },
    handoffs: [], notes: [],
  };
}

/**
 * Walks the definition and outcomes. A label uses the first live role; { event, role, index } names a caller.
 * Returns { status, reason, active, steps }. status is done, refused, or running.
 * A refused leave leaves the live role where it was.
 */
export function compileTrace(definition: TraceDefinition, outcomes: TraceOutcome[], now = () => 0): Trace {
  const run = traceRun(definition);
  const steps: TraceStep[] = [];
  const enter = (tokens: Token[]) => {
    for (const token of tokens) steps.push({ step: "enter", role: token.role, index: token.index });
  };
  enter(run.live);
  for (const outcome of outcomes) {
    if (!run.live.length) {
      const reason = "no live role";
      steps.push({ step: "leave", refused: reason });
      return { status: "refused", reason, active: run.active, steps };
    }
    const explicit = outcome && typeof outcome === "object";
    const token = explicit ? outcome : run.live[0];
    const event = explicit ? outcome.event : outcome;
    const caller = run.instances[token.role]?.[token.index] ?? "";
    steps.push({ step: "event", role: token.role, index: token.index, event });
    let plan;
    try {
      plan = decide(run, event, caller, false);
    } catch (error) {
      steps.push({ step: "leave", role: token.role, index: token.index, event, refused: (error as Error).message });
      return { status: "refused", reason: (error as Error).message, active: run.active, steps };
    }
    if (plan.limit) {
      steps.push({ step: "leave", role: token.role, index: token.index, event, refused: plan.limit });
      return { status: "refused", reason: plan.limit, active: run.active, steps };
    }
    const committed = commitDecided(run, plan, { on: event, note: "", override: false, by: "", caller, now, confirmed: false });
    steps.push({ step: "leave", role: token.role, index: token.index, event, kind: committed.kind, to: plan.handoff.to });
    if (committed.kind === "done" && run.status === "done") steps.push({ step: "done" });
    if (committed.kind === "stall") return { status: "refused", reason: run.error, active: run.active, steps };
    if (committed.kind === "move") enter(committed.targets.map((target: { role: Role; index: number }) => ({ role: target.role.id, index: target.index })));
  }
  return { status: run.status, active: run.active, steps };
}
