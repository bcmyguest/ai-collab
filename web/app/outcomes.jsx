import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

export function OutcomeRequest({ project, close, submit, disabled, error }) {
  return <Sheet open={Boolean(project)} onOpenChange={open => { if (!open) close(); }}>
    <SheetContent side="bottom" className="max-h-dvh overflow-y-auto p-4 sm:px-8">
      <SheetTitle>Request an outcome</SheetTitle>
      <SheetDescription>The PM will propose tasks for {project}.</SheetDescription>
      <form key={project} className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        submit({ outcome: fields.get("outcome"), check: fields.get("check") });
      }}>
        <label className="grid gap-1">Requested outcome
          <input name="outcome" required maxLength={500} className="min-h-11 rounded-md border bg-background px-3 text-base"/>
        </label>
        <label className="grid gap-1">Acceptance check
          <input name="check" required maxLength={500} className="min-h-11 rounded-md border bg-background px-3 text-base"/>
        </label>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Button disabled={disabled} className="min-h-11 self-start">Send to PM</Button>
      </form>
    </SheetContent>
  </Sheet>;
}

export function OutcomeCards({ outcomes, tasks, inspect, controls }) {
  if (!outcomes?.length) return null;
  const byId = new Map(tasks.map(task => [task.id, task]));
  return <section aria-label="Project outcomes" className="grid gap-2">
    {outcomes.map(entry => {
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
        {entry.state === "approved" && done && !entry.result && <p>Waiting for the PM to report the result.</p>}
        {entry.result && <p><strong>{entry.result.passed ? "Passed" : "Failed"}</strong> · {entry.result.text}</p>}
        {entry.state === "proposed" && <Button className="min-h-11 justify-self-start" disabled={controls.disabled || controls.paused}
          onClick={() => controls.act("approve-outcome", { id: entry.id }, "Plan approved")}>Approve plan</Button>}
        {entry.state === "approved" && done && entry.result?.passed && <Button className="min-h-11 justify-self-start" disabled={controls.disabled}
          onClick={() => controls.act("accept-outcome", { id: entry.id, revision: entry.result.revision }, "Outcome closed")}>Accept result and close</Button>}
      </article>;
    })}
  </section>;
}
