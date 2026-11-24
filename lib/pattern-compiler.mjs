// A team graph plus a list of outcomes (edge labels) is the step log. decide owns the cap,
// required-edge, and done rules. This walk only records enter, event, and leave.
import { commitDecided, decide } from "./pattern-runs.mjs";

const countOf = (role) => role.count ?? 1;

/** The run shape decide reads, with one stand-in session per instance so a trace needs no harness. */
function traceRun(definition) {
  const entry = definition.roles[0];
  const instances = {};
  const sessions = {};
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
 * Walks definition (the snapshot decide already uses) and outcomes, in order.
 * Returns { status, reason, active, steps }. status is done, refused, or running.
 * A refused leave leaves the live role where it was.
 */
export function compileTrace(definition, outcomes, now = () => 0) {
  const run = traceRun(definition);
  const steps = [];
  const enter = (tokens) => {
    for (const token of tokens) steps.push({ step: "enter", role: token.role, index: token.index });
  };
  enter(run.live);
  for (const outcome of outcomes) {
    const token = run.live[0];
    if (!token) {
      const reason = "no live role";
      steps.push({ step: "leave", refused: reason });
      return { status: "refused", reason, active: run.active, steps };
    }
    const caller = run.instances[token.role]?.[token.index] ?? "";
    steps.push({ step: "event", role: token.role, index: token.index, event: outcome });
    let plan;
    try {
      plan = decide(run, outcome, caller, false);
    } catch (error) {
      steps.push({ step: "leave", role: token.role, index: token.index, event: outcome, refused: error.message });
      return { status: "refused", reason: error.message, active: run.active, steps };
    }
    if (plan.limit) {
      steps.push({ step: "leave", role: token.role, index: token.index, event: outcome, refused: plan.limit });
      return { status: "refused", reason: plan.limit, active: run.active, steps };
    }
    const committed = commitDecided(run, plan, { on: outcome, note: "", override: false, by: "", caller, now, confirmed: false });
    steps.push({ step: "leave", role: plan.role, index: plan.indexes[0], event: outcome, kind: committed.kind, to: plan.handoff.to });
    if (committed.kind === "done" && run.status === "done") {
      steps.push({ step: "done" });
      return { status: "done", active: run.active, steps };
    }
    if (committed.kind === "stall") return { status: "refused", reason: run.error, active: run.active, steps };
    if (committed.kind === "move") enter(committed.targets.map((target) => ({ role: target.role.id, index: target.index })));
  }
  return { status: run.status, active: run.active, steps };
}
