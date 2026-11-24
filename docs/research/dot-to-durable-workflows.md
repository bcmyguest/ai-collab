# A team file is already a durable workflow

Read from `origin/main` at `9a297275`. No runner code was changed.

The pasted class is the Cloudflare Agents SDK. It programs three durable operations by hand: write state to SQLite, start a multi-step workflow, and arm an alarm that still fires after a restart. A team `.dot` file already names those three things. The build is one compiler that reads the file and emits the workflow. A new team does not get a new class, and the agent is not the thing under test.

```ts
import { Agent, callable } from "agents";

export class DurableResearchAgent extends Agent<Env, { status: string; notes: string[] }> {
  initialState = { status: "idle", notes: [] };

  @callable()
  async startTask(topic: string) {
    this.setState({ ...this.state, status: "running" });
    const instance = await this.env.RESEARCH_WORKFLOW.create({
      params: { agentId: this.name, topic }
    });
    await this.schedule(300, "checkProgress", { workflowId: instance.id });
    return instance.id;
  }

  async checkProgress(payload: { workflowId: string }) {
    console.log("Checking durable workflow:", payload.workflowId);
  }
}
```

`RESEARCH_WORKFLOW` is a second program, not shown in the paste. That second program is what we stop writing. The product team, the review team, and the architect team stay DOT.

## What the class is doing

| Line | Durable effect | What survives a restart |
|---|---|---|
| `this.setState({ status: "running" })` | The agent's row in SQLite changes before the method returns | The status. A reboot still shows `running` |
| `env.RESEARCH_WORKFLOW.create({ params })` | A workflow instance with its own step log | The step that was in progress, and every finished step's output |
| `this.schedule(300, "checkProgress", …)` | An alarm stored with the agent | The alarm. Five minutes later the method runs even if the process was gone |

The class is a sketch of the runtime we want. It is a poor sketch of the authoring model. Every new shape of work becomes another TypeScript class, and the graph the operator already edits is ignored.

## What a DOT file already declares

`lib/team-templates/product/team.dot` is the example. The graph comment and the node prompts are the step bodies. The edges are the control flow.

| DOT | Meaning for a workflow |
|---|---|
| A role (`pm`, `engineer`, `review`, `ceo`) | One step. `agent` is the harness and model. `prompt` is the step body. `fallback` is the recorded alternate when that harness cannot take the step |
| `pm -> engineer [on="in vision", required=true]` | The event that completes the `pm` step and starts `engineer`. The workflow cannot finish while this edge has not fired |
| `review -> engineer [on="changes", required=false, cap=3]` | An optional edge. The same instance may take it at most three times. The count is part of the step log, so a replay does not grant a fourth round |
| `pm -> ceo [on="several tasks", required=false]` | An optional edge the PM emits. It is not a timer written into a class |
| `pm -> done [on="task closed"]` and `ceo -> done [on="course set"]` | Terminal edges. A required incoming edge that has not fired still blocks `done`, which `decide` already enforces |
| The task text passed to `team start` | The workflow input, in the same role as `topic` in the paste |

`decide` in `lib/pattern-runs.mjs` is already the transition function: the live role, the event name, the cap, fan-in, and `done`. The interpreter calls that function. It does not reimplement it.

## One interpreter, every team

Starting a run is the body of `startTask`, with the team name in place of the class name.

1. Persist the run as `running`, with the definition snapshot and the task text. `preparePatternRun` already builds that object. The snapshot is the workflow input, so a later edit to the DOT does not change a run that has started.
2. Create one workflow. The id is the run id. The name is `pattern`. There is no generated `ProductWorkflow` class.
3. Arm one watchdog for the run. The delay is a property of the runtime, not a method on a team. When the active role emits an event, the alarm is cleared and re-armed for the next role. If it fires, the run is marked stalled and the operator can see which role is held. It does not invent a handoff.

Each role visit is the same step shape.

| Step | Does | Recorded output | On a cut |
|---|---|---|---|
| `enter <role>#<index>` | Start the session, or message the session that already holds that instance | The session address | Do not start a second session. The address was written before the harness was asked to work. Recovery sends the brief to that address |
| `event <role>#<index>` | Wait until that session emits an edge label (`built`, `reported`, `task closed`) | The event name and the note | The wait is not consumed until the event is recorded, so the event is not lost |
| `leave <role>#<index>` | Call `decide`. A `move` names the next instances. A `done` completes the workflow. A cap or a missing required edge is the recorded refusal | The plan `decide` returned | Replay returns that plan. The next `enter` is a later step, so a crash after the decision cannot fire the edge twice and also cannot skip it |

`launchPatternRun` and `activate` are the bodies of `enter`. `applyPatternAdvance` is the body of `leave`. The new code is the loop that calls them inside the step log. The DOT parser, the prompts, and `decide` stay.

A role with `count` greater than 1 is one `enter`/`event`/`leave` chain per instance. A `pair` edge advances the caller's index. A fan-in edge waits until every instance has arrived, which `decide` already returns as `kind: "wait"`. That wait is a finished step whose output is "not yet", and the workflow keeps waiting for the other instances.

## Where the checkpoint lives

`runner/durable.mjs` already stores this shape in `runner.db`: a `workflows` row, a `steps` row per call, replay of a `done` step, and `onCut` for a step left in `started`. Owned sessions already use it (`sessionWorkflow` in `runner/runner.mjs`). A pattern run does not. `writeState` writes the run JSON, and `advanceRun` applies the event in the request that received it. A crash between accepting the event and starting the next role is not a step boundary.

The pattern workflow uses that same log. Workflow id `pattern-<run id>`, name `pattern`. A `done` step returns its recorded output and does not launch again. A step left `started` uses `onCut` and does not call the harness a second time. The run JSON can stay as the view the phone reads. The step log is the authority for what has been decided.

This does not require the Cloudflare Agents SDK, a Cloudflare account, or celld. celld can host the same interpreter later, because it runs Workers and Workflows from a `wrangler.json`. The authoring stays the DOT file either way. OpenShell stays the place the harness runs. Durability is the record of which role is live and which edge fired, not a second sandbox.

The existing decision still stands for the runner itself: the SQLite layer keeps the DBOS names, and Postgres is not added for a single-user machine (`docs/owned-sessions-contract.md`, `docs/orchestration-migration-spike.md`). The task `migrate-builder-and-runner-orchestration` is that engine choice. This note is the authoring model on top of whichever engine keeps those step rules. Builders stay capped at two. Compiling a DOT file does not start a builder.

## The compiler is the part that can be proved

The agent stays outside the proof. Lean, or any checker with the same shape, takes the graph and a list of outcomes and returns the step log. An outcome is an edge label a role emitted: `in vision`, `built`, `changes`, `reported`, `task closed`. The checker does not see the prompt, the patch, or the model.

A good trace for the product team is `in vision`, `built`, `reported`, `task closed`. The log enters engineer, then review, then pm, then done. A bad trace opens with `task closed`: `decide` refuses, because `in vision`, `built`, and `reported` have not fired. Another bad trace emits `changes` four times from the same review instance: the fourth hits the cap. Those traces are the tests. The agent does not write them, and no test code runs inside the agent.

The properties are a pure function of the graph and the trace, which is why a proof assistant can take them:

- A required edge that has not fired blocks `done`.
- A capped edge does not fire once more than its cap, including when the log is replayed.
- An event the live role does not have is refused, and the live role stays put.
- Replaying a finished `leave` returns the same next role and does not append a second handoff.

Whether the engineer's change is the one the task asked for, and whether the review's screen-state result is honest, stay outside the proof. Those are the outcomes the role emits. The compiler decides whether that outcome was allowed and which role is next.

The trace tests can land before any Lean development. They run `decide` on the product DOT and the lists above. They do not start a harness.

## What this is not

- A second graph language. The phone already edits the DOT.
- A generated `Agent` subclass per team. Adding a role is editing the file and starting a run.
- The live diagram. `docs/research/live-team-diagram.md` draws a run. This note is what resumes one.
- A timer baked into the product team. "Every few tasks" remains the event `several tasks` that the PM emits.

## Smallest build

1. One workflow registration, `pattern`, input `{ name, task, definition }`.
2. `enter` / `event` / `leave` as steps, calling `launchPatternRun`, the wait for the edge, and `decide`.
3. The watchdog as one scheduled wake on that workflow id, cleared when `event` completes.
4. Trace tests on the product DOT, with no harness and no test written for an agent. The good trace `in vision`, `built`, `reported`, `task closed` ends at done. An opening `task closed` is refused. A fourth `changes` from the same review instance is refused.
5. A recovery test that kills the process after `leave` has recorded `built` and before `review` is launched: `review` starts once, and `built` is not applied again.

No new team file is required. The product DOT is the fixture. The trace tests are the ones Lean can later take as theorems. The recovery test checks the step log around the process.
