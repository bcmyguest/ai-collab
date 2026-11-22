"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ageOf, boardClock, columnsOf, countsOf, FILTERS, statusLabel } from "@/lib/task-board";
import { priorityOf, sortTasks } from "../../lib/task-order.mjs";
import { cn } from "@/lib/utils";
import { TaskGraph } from "./task-graph";

const DOT = { open: "bg-muted-foreground", decided: "bg-sky-500", building: "bg-amber-500", blocked: "bg-destructive", done: "bg-emerald-500" };
const PRIORITY_BADGE = {
  P0: "border-destructive/40 bg-destructive/10 text-destructive",
  P1: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  P2: "border-border bg-muted text-muted-foreground",
  P3: "border-border bg-transparent text-muted-foreground/70",
};
const VIEWS = [["board", "Board"], ["graph", "Graph"]];
const CARD = "flex w-full min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-3 text-left text-sm";
// A long column renders its rows lazily instead of building every off-screen card: the browser skips layout and paint for
// the cards outside the viewport, which is what makes a large list scroll smoothly on a phone. The intrinsic size keeps
// the scrollbar stable until a card has been laid out once (auto remembers the real height after that).
const LAZY = "[content-visibility:auto] [contain-intrinsic-size:auto_7rem]";

/**
 * One task card. Memoized on the age string it prints (not the raw clock), so an unchanged task does not re-render and
 * re-layout while the list scrolls; the coarse clock in the board means that string rarely changes either.
 */
const Card = memo(function Card({ task, age, compose }) {
  const body = <>
    <div className="flex min-w-0 items-start gap-2">
      <Badge variant="outline" aria-label={`priority ${priorityOf(task)}`} className={cn("shrink-0 font-mono text-[10px]", PRIORITY_BADGE[priorityOf(task)])}>{priorityOf(task)}</Badge>
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
      {task.ownerRunningJobs > 0 && <span>{task.ownerRunningJobs} running {task.ownerRunningJobs === 1 ? "job" : "jobs"}</span>}
      {task.run && <Badge variant="outline" className="font-mono">run {task.run}</Badge>}
      {task.blockers?.length > 0 && <span>waits on {task.blockers.join(", ")}</span>}
    </div>
    {task.question?.answer && <p className="break-words text-xs"><span className="text-muted-foreground">{task.question.text} → </span><span className="font-medium">{task.question.answer.text}</span></p>}
    {task.last && <p className="flex min-w-0 gap-2 border-l-2 pl-2 text-xs">
      <span className="min-w-0 flex-1 break-words">{task.last.text}</span>
      <span className="shrink-0 text-muted-foreground">{age} ago</span>
    </p>}
  </>;
  return <li className={LAZY}>
    <button type="button" aria-label={`Message about ${task.title}`} onClick={() => compose(task.id)} className={cn(CARD, "transition-colors hover:bg-accent")}>{body}</button>
  </li>;
});

/** A task question waiting on the operator: tap a choice or type an answer; it is stored on the task, no agent turn runs. */
function Decision({ task, decide, compose }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async answer => {
    const value = String(answer).trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await decide(task.id, value);
    setBusy(false);
    if (ok) setText("");
  };
  const q = task.question;
  return <li className="flex min-w-0 flex-col gap-2 rounded-xl border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
    <div className="flex min-w-0 items-start gap-2">
      <Badge variant="outline" className={cn("shrink-0 font-mono text-[10px]", PRIORITY_BADGE[priorityOf(task)])}>{priorityOf(task)}</Badge>
      <button type="button" onClick={() => compose(task.id)} className="min-w-0 flex-1 text-left font-medium leading-snug break-words hover:underline">{task.title}</button>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.id}</span>
    </div>
    <p className="break-words">{q.text}</p>
    <p className="text-xs text-muted-foreground">asked by <span className="font-mono">{q.by}</span></p>
    {q.options?.length > 0 && <div role="group" aria-label="Choices" className="flex flex-wrap gap-2">
      {q.options.map(option => <Button key={option} type="button" size="sm" variant="outline" disabled={busy}
        className="h-auto min-h-8 whitespace-normal rounded-full text-left" onClick={() => send(option)}>{option}</Button>)}
    </div>}
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); send(text); }}>
      <input value={text} onChange={event => setText(event.target.value)} maxLength={500} aria-label={`Answer for ${task.title}`}
        placeholder={q.options?.length ? "Or type your own answer" : "Your decision"} enterKeyHint="send"
        className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
      <Button type="submit" size="sm" className="h-9" disabled={busy || !text.trim()}>Decide</Button>
    </form>
  </li>;
}

/** One status column: its count header and its cards; memoized so filtering or the clock does not rebuild unchanged columns. */
const Column = memo(function Column({ status, list, now, compose }) {
  return <section aria-label={status} className="flex min-w-0 flex-col gap-2">
    <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <span aria-hidden className={cn("inline-block size-2 rounded-full", DOT[status])}/>{statusLabel(status)} · {list.length}
    </h2>
    {list.length ? <ul className="flex flex-col gap-2">{list.map(task => <Card key={task.id} task={task} age={task.last ? ageOf(task.last.at, now) : ""} compose={compose}/>)}</ul>
      : <p className="text-xs text-muted-foreground">No {statusLabel(status)} tasks.</p>}
  </section>;
});

/** The status board: one column per status, stacked on a phone and side by side from md up, with a status filter. */
export function TaskBoard({ board, now, open, compose, decide, taskId, back }) {
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("board");
  const tasks = board?.tasks || [];
  const columns = useMemo(() => columnsOf(tasks, filter), [tasks, filter]);
  const counts = useMemo(() => countsOf(tasks), [tasks]);
  // Ages render at the coarsest clock that stays exact, so a per-second tick rarely reaches a column at all.
  const clock = useMemo(() => boardClock(tasks, now), [tasks, now]);
  // A stable callback: the parent re-renders every second, and a fresh arrow each time would re-render every card.
  const composeRef = useRef(compose);
  useEffect(() => { composeRef.current = compose; });
  const message = useCallback(id => composeRef.current(id), []);
  const task = taskId && tasks.find(item => item.id === taskId);
  const waiting = useMemo(() => sortTasks(tasks.filter(item => item.question && !item.question.answer)), [tasks]);
  // The list scrolls on its own, so a large board never makes the page body scroll or jump as cards resize.
  return <section aria-label="Task board" className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 py-4">
    {board?.error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">Task store is invalid: {board.error}</p>}
    {taskId ? <>
      <Button type="button" size="sm" variant="outline" className="self-start" onClick={back}>Back to board</Button>
      {task?.question && !task.question.answer && decide && <ul><Decision task={task} decide={decide} compose={message}/></ul>}
      {task ? <Column status={task.status} list={[task]} now={clock} compose={message}/>
        : board && !board.error && <p role="status">Task #{taskId} was not found.</p>}
    </> : <>
      {waiting.length > 0 && decide && <section aria-label="Needs your decision" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
          <span aria-hidden className="inline-block size-2 rounded-full bg-amber-500"/>Needs you · {waiting.length}
        </h2>
        <ul className="flex flex-col gap-2 md:grid md:grid-cols-2">{waiting.map(item => <Decision key={item.id} task={item} decide={decide} compose={message}/>)}</ul>
      </section>}
      <div role="group" aria-label="View" className="flex gap-2">
        {VIEWS.map(([id, name]) => <Button key={id} type="button" size="sm" variant={view === id ? "default" : "outline"}
          aria-pressed={view === id} className="h-8 rounded-full" onClick={() => setView(id)}>{name}</Button>)}
      </div>
      {view === "graph" ? <TaskGraph tasks={tasks} open={open}/> : <>
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
          {FILTERS.map(status => <Button key={status} type="button" size="sm" variant={filter === status ? "default" : "outline"}
            aria-pressed={filter === status} className="h-8 rounded-full capitalize" onClick={() => setFilter(status)}>
            {status === "all" ? "All" : statusLabel(status)} · {status === "all" ? tasks.length : counts[status]}
          </Button>)}
        </div>
        <div className="flex flex-col gap-4 md:grid md:grid-cols-5 md:items-start">
          {columns.map(([status, list]) => <Column key={status} status={status} list={list} now={clock} compose={message}/>)}
        </div>
      </>}
    </>}
  </section>;
}
