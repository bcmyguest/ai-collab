// One pattern run on the durable log: enter a role, wait for its event, leave through decide.
// The workflow id is pattern-<run id>. The input is the team snapshot the run started with.

// oxlint-disable-next-line typescript/no-explicit-any -- run replies, leave outcomes and messages are pattern-run JSON
type Json = any;
type Role = { id: string; count?: number };

/** The durable workflow context a pattern run uses (lib/durable). */
interface PatternWf {
  id: string;
  signal: AbortSignal;
  step<T>(name: string, fn: () => Promise<T>, opts?: { onCut?: () => T | Promise<T> }): Promise<T>;
  recv(topic: string, opts: { name: string }): Promise<Json>;
}

export interface PatternDeps {
  enterEntry(input: Json, runId: string): Promise<Json>;
  cutEntry(input: Json, runId: string): Json;
  reply?(request: Json, body: { reply?: Json; error?: Json }): void;
  leave(runId: string, message: Json): Promise<Json>;
  cutLeave(runId: string, message: Json): Json;
  between?(wf: PatternWf, left: Json): Promise<void> | void;
  enterNext(runId: string, left: Json): Promise<Json>;
  afterEnter?(wf: PatternWf, next: Json): Promise<void> | void;
  cutEnter(runId: string, left: Json): Json;
}

export function patternWorkflowId(runId: string): string {
  return `pattern-${runId}`;
}

export function runIdOfPatternWorkflow(workflowId: string | null | undefined): string {
  const prefix = "pattern-";
  if (!workflowId?.startsWith(prefix)) throw new Error(`not a pattern workflow: ${workflowId}`);
  return workflowId.slice(prefix.length);
}

/** The run launchPatternRun writes. project stays on the workflow input so recovery can find the run file. */
export function seedPatternRun({ name, task, definition }: { name: string; task: string; definition: { roles: Role[] } & Record<string, unknown> }, runId: string, now: number | (() => number) = Date.now) {
  const entry = definition.roles[0];
  const count = entry.count ?? 1;
  return {
    id: runId, openshell: true, runner: true, pattern: name, definition, task, status: "running", active: entry.id,
    live: Array.from({ length: count }, (_, index) => ({ role: entry.id, index })),
    sessions: {}, instances: {}, arrivals: {}, visits: { [entry.id]: Array.from({ length: count }, () => 1) },
    handoffs: [], notes: [], startedAt: typeof now === "function" ? now() : now,
  };
}

/**
 * Steps are enter, event, and leave. A finished step returns its recorded output.
 * A step left started uses onCut and does not call the harness again.
 * deps.between runs after leave is durable and before the next enter, so a test can stop there.
 */
export async function runPatternWorkflow(wf: PatternWf, input: Json, deps: PatternDeps): Promise<Json> {
  const runId = runIdOfPatternWorkflow(wf.id);
  const entry = await wf.step("enter", async () => {
    const started = await deps.enterEntry(input, runId);
    wf.signal.throwIfAborted();
    return { reply: started.reply ?? started };
  }, { onCut: () => deps.cutEntry(input, runId) });
  deps.reply?.(input.request, { reply: entry.reply });
  let reply = entry.reply;
  while (reply?.status === "running" || reply?.status === "suspended") {
    const message = await wf.recv("advance", { name: "event" });
    const left = await wf.step("leave", async () => {
      const outcome = await deps.leave(runId, message);
      wf.signal.throwIfAborted();
      return outcome;
    }, { onCut: () => deps.cutLeave(runId, message) });
    if (deps.between) await deps.between(wf, left);
    if (left.launch) {
      const entered = await wf.step("enter", async () => {
        const next = await deps.enterNext(runId, left);
        if (deps.afterEnter) await deps.afterEnter(wf, next);
        wf.signal.throwIfAborted();
        return next;
      }, { onCut: () => deps.cutEnter(runId, left) });
      if (entered.reply?.status === "failed") {
        deps.reply?.(message.request, { reply: entered.reply });
        return entered.reply;
      }
      if (entered.reply) left.reply = { ...left.reply, ...entered.reply, handoff: left.reply?.handoff ?? entered.reply.handoff };
    }
    if (left.error) deps.reply?.(message.request, { error: left.error });
    else deps.reply?.(message.request, { reply: left.reply });
    if (left.reply) reply = left.reply;
  }
  return reply;
}
