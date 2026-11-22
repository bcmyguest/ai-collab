import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { columnsOf, FILTERS, ageOf } from "@/lib/task-board";
import { cn } from "@/lib/utils";

const DOT = { open: "bg-muted-foreground", decided: "bg-sky-500", building: "bg-amber-500", blocked: "bg-destructive", done: "bg-emerald-500" };

function Card({ task, now }) {
  return <li className="flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-sm">
    <div className="flex min-w-0 items-start gap-2">
      <span className="min-w-0 flex-1 font-medium leading-snug break-words">{task.title}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.id}</span>
    </div>
    {task.detail && <p className="text-xs text-muted-foreground break-words">{task.detail}</p>}
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {task.owner ? <span className="flex min-w-0 items-center gap-1.5 font-mono">
        <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", task.ownerOnline ? "bg-emerald-500" : "bg-muted-foreground/40")}/>
        <span className="truncate">{task.owner}</span>
        <span className="sr-only">{task.ownerOnline ? "online" : "offline"}</span>
      </span> : <span>No owner</span>}
      {task.run && <Badge variant="outline" className="font-mono">run {task.run}</Badge>}
      {task.blockers?.length > 0 && <span>waits on {task.blockers.join(", ")}</span>}
    </div>
    {task.last && <p className="flex min-w-0 gap-2 border-l-2 pl-2 text-xs">
      <span className="min-w-0 flex-1 break-words">{task.last.text}</span>
      <span className="shrink-0 text-muted-foreground">{ageOf(task.last.at, now)} ago</span>
    </p>}
  </li>;
}

/** The status board: one column per status, stacked on a phone and side by side from md up, with a status filter. */
export function TaskBoard({ board, now }) {
  const [filter, setFilter] = useState("all");
  const tasks = board?.tasks || [];
  const columns = columnsOf(tasks, filter);
  return <section aria-label="Task board" className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4">
    {board?.error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">Task store is invalid: {board.error}</p>}
    <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
      {FILTERS.map(status => <Button key={status} type="button" size="sm" variant={filter === status ? "default" : "outline"}
        aria-pressed={filter === status} className="h-8 rounded-full capitalize" onClick={() => setFilter(status)}>
        {status === "all" ? "All" : status} · {status === "all" ? tasks.length : tasks.filter(task => task.status === status).length}
      </Button>)}
    </div>
    <div className="flex flex-col gap-4 md:grid md:grid-cols-5 md:items-start">
      {columns.map(([status, list]) => <section key={status} aria-label={status} className="flex min-w-0 flex-col gap-2">
        <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <span aria-hidden className={cn("inline-block size-2 rounded-full", DOT[status])}/>{status} · {list.length}
        </h2>
        {list.length ? <ul className="flex flex-col gap-2">{list.map(task => <Card key={task.id} task={task} now={now}/>)}</ul>
          : <p className="text-xs text-muted-foreground">No {status} tasks.</p>}
      </section>)}
    </div>
  </section>;
}
