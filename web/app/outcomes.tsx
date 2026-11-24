import { Input } from "@ui-sdk/react/input";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

type OutcomeRequestProps = {
  project: string;
  close: () => void;
  submit: (fields: { outcome: string; check: string }) => void;
  disabled: boolean;
  error: string;
};

type OutcomeCardsProps = {
  outcomes?: Array<{
    id: string;
    outcome: string;
    check: string;
    state: "requested" | "proposed" | "approved" | "closed";
    taskIds?: string[];
    titles?: string[];
    result?: { passed: boolean; text: string; revision: string };
  }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  inspect: (id: string) => void;
  controls: {
    disabled: boolean;
    paused: boolean;
    act: (action: "approve-outcome" | "accept-outcome", fields: { id: string; revision?: string }, message: string) => void;
  };
};

const INPUT_CLASS = "min-h-11 rounded-md border bg-background px-3 text-base";

export function OutcomeRequest({ project, close, submit, disabled, error }: OutcomeRequestProps) {
  return <Sheet open={Boolean(project)} onOpenChange={(open: boolean) => { if (!open) close(); }}>
    <SheetContent side="bottom" className="max-h-dvh overflow-y-auto p-4 sm:px-8">
      <SheetTitle>Request an outcome</SheetTitle>
      <SheetDescription>The PM will propose tasks for {project}.</SheetDescription>
      <form key={project} className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const outcome = fields.get("outcome");
        const check = fields.get("check");
        if (typeof outcome === "string" && typeof check === "string") submit({ outcome, check });
      }}>
        <label className="grid gap-1">Requested outcome
          <Input name="outcome" required maxLength={500} className={INPUT_CLASS}/>
        </label>
        <label className="grid gap-1">Acceptance check
          <Input name="check" required maxLength={500} className={INPUT_CLASS}/>
        </label>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Button disabled={disabled} className="min-h-11 self-start">Send to PM</Button>
      </form>
    </SheetContent>
  </Sheet>;
}

export function OutcomeCards({ outcomes, tasks, inspect, controls }: OutcomeCardsProps) {
  if (!outcomes?.length) return null;
  const byId = new Map(tasks.map(task => [task.id, task]));
  return <section aria-label="Project outcomes" className="grid gap-2">
    {outcomes.map(entry => {
      const result = entry.result;
      const linked = entry.taskIds?.map(id => byId.get(id));
      const done = linked?.every(task => task?.status === "done");
      const status = {
        requested: "Open · Waiting for PM proposal",
        proposed: "Open · Waiting for approval",
        approved: done ? "Open · Acceptance check" : "Open · Tasks in progress",
        closed: "Closed",
      }[entry.state];
      return <article key={entry.id} className="grid gap-2 rounded-xl border bg-card p-3 text-sm [overflow-wrap:anywhere]">
        <h2 className="font-semibold">{entry.outcome}</h2>
        <p className="text-muted-foreground">{status}</p>
        <p><strong>Acceptance check</strong> · {entry.check}</p>
        {entry.titles && <ul className="grid gap-1">
          {entry.titles.map((title, index) => {
            const task = linked?.[index];
            return <li key={title}>{task ? <button type="button" className="min-h-9 text-left underline" onClick={() => inspect(task.id)}>
              {task.title}{task.status === "done" ? " · Done" : ""}
            </button> : title}</li>;
          })}
        </ul>}
        {entry.state === "approved" && done && !result && <p>Waiting for the PM to report the result.</p>}
        {result && <p><strong>{result.passed ? "Passed" : "Failed"}</strong> · {result.text}</p>}
        {entry.state === "proposed" && <Button className="min-h-11 justify-self-start" disabled={controls.disabled || controls.paused}
          onClick={() => controls.act("approve-outcome", { id: entry.id }, "Plan approved")}>Approve plan</Button>}
        {entry.state === "approved" && done && result?.passed && <Button className="min-h-11 justify-self-start" disabled={controls.disabled}
          onClick={() => controls.act("accept-outcome", { id: entry.id, revision: result.revision }, "Outcome closed")}>Accept result and close</Button>}
      </article>;
    })}
  </section>;
}
