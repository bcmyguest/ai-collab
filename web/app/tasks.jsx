"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ageOf, boardClock, columnsOf, countsOf, FILTERS, statusLabel } from "@/lib/task-board";
import { priorityOf, sortTasks } from "../../lib/task-order.mjs";
import { cn } from "@/lib/utils";
import { views } from "@/lib/view-memory";
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
const LAZY = "[content-visibility:auto] [contain-intrinsic-size:auto_7rem]";

function TaskMetadata({ task, fullId }) {
  const priority = priorityOf(task);
  return <div className="flex w-full min-w-0 items-start gap-2">
    <Badge variant="outline" aria-label={`priority ${priority}`} className={cn("shrink-0 font-mono text-[10px]", PRIORITY_BADGE[priority])}>{priority}</Badge>
    <span className={cn("min-w-0 font-mono text-[11px] text-muted-foreground", fullId ? "wrap-anywhere" : "truncate")}>{task.id}</span>
  </div>;
}

const Card = memo(function Card({ task, age, compose, open, fullId, continuation, recover }) {
  const body = <>
    <TaskMetadata task={task} fullId={fullId}/>
    <span className="w-full font-medium leading-snug wrap-break-word">{task.title}</span>
    {task.detail && <p className="text-xs text-muted-foreground break-words">{task.detail}</p>}
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {task.owner ? <span className="flex min-w-0 items-center gap-1.5 font-mono">
        <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", task.ownerOnline ? "bg-emerald-500" : "bg-muted-foreground/40")}/>
        <span className="truncate">{task.owner}</span>
        <span className="sr-only">{task.ownerOnline ? "online" : "offline"}</span>
      </span> : <span>{task.builderUnit || "No owner"}</span>}
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
    {task.recovery && recover && <BuilderRecovery task={task} recover={recover}/>}
    {task.owner && !task.recovery && <Button type="button" size="sm" variant="ghost" onClick={() => open(task.owner)}>Open owner session</Button>}
    {task.previousHarness && continuation && !task.recovery && <ContinueBuilder task={task} {...continuation}/>}
  </li>;
});

function ContinueBuilder({ task, harnesses, launch }) {
  const choices = harnesses.filter(harness => harness !== task.previousHarness);
  const [selected, select] = useState("");
  const [pending, setPending] = useState(false);
  const harness = choices.includes(selected) ? selected : choices[0];
  if (!harness) return null;
  return <form className="flex flex-wrap items-center gap-2 px-2 pb-2" onSubmit={async event => {
    event.preventDefault();
    setPending(true);
    try { await launch(task.id, harness); } finally { setPending(false); }
  }}>
    <select aria-label="Replacement harness" value={harness} disabled={pending} onChange={event => select(event.target.value)}>
      {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
    </select>
    <Button type="submit" size="sm" variant="outline" disabled={pending}>
      {pending ? "Starting…" : "Continue with another agent"}
    </Button>
    <span className="text-xs text-muted-foreground">Runs locally in the existing worktree</span>
  </form>;
}

function BuilderRecovery({ task, recover }) {
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const { worktree, branch, commits, backup, harness, choices } = task.recovery;
  async function launch(nextHarness) {
    if (busy) return;
    setBusy(true);
    try { await recover(task.id, nextHarness); }
    finally { setBusy(false); }
  }
  return <section aria-label="Builder recovery" className="flex flex-col gap-2 rounded-xl border border-amber-500/50 p-3 text-xs">
    <p className="font-medium">Builder needs recovery</p>
    {!task.last && <p>No progress update recorded</p>}
    <p className="wrap-anywhere">Worktree {worktree}</p>
    <p className="wrap-anywhere">Branch {branch} · {commits} recorded {commits === 1 ? "commit" : "commits"}</p>
    {backup && <p className="wrap-anywhere">Saved workspace {backup}</p>}
    {task.recovery.sandboxWorkspace && <p>Workspace available to retrieve from the previous sandbox</p>}
    <Button type="button" variant="outline" disabled={busy} onClick={() => launch()}>Restart {harness}</Button>
    <select aria-label="Replacement builder" className="min-h-9 rounded-md border bg-background px-2"
      value={replacement} disabled={busy} onChange={event => setReplacement(event.target.value)}>
      <option value="">Choose a replacement</option>
      {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
    </select>
    <Button type="button" disabled={busy || !replacement} onClick={() => launch(replacement)}>Reassign builder</Button>
  </section>;
}

function Decision({ task, decide, compose, fullId }) {
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
    <TaskMetadata task={task} fullId={fullId}/>
    <button type="button" onClick={() => compose(task.id)} className="w-full text-left font-medium leading-snug wrap-break-word hover:underline">{task.title}</button>
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

const Column = memo(function Column({ status, list, now, compose, open, fullId, continuation, recover }) {
  return <section aria-label={status} className="flex min-w-0 flex-col gap-2">
    <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <span aria-hidden className={cn("inline-block size-2 rounded-full", DOT[status])}/>{statusLabel(status)} · {list.length}
    </h2>
    {list.length ? <ul className="flex flex-col gap-2">{list.map(task => <Card key={task.id} task={task} age={task.last ? ageOf(task.last.at, now) : ""} compose={compose} open={open} fullId={fullId} continuation={continuation} recover={recover}/>)}</ul>
      : <p className="text-xs text-muted-foreground">No {statusLabel(status)} tasks.</p>}
  </section>;
});

export function TaskBoard({ project, board, now, open, compose, decide, taskId, back, continuation, recover }) {
  const filterKey = "task filter " + project;
  const [filter, setFilter] = useState(() => views.get(filterKey, "all"));
  const [view, setView] = useState("board");
  const tasks = board?.tasks || [];
  const columns = useMemo(() => columnsOf(tasks, filter), [tasks, filter]);
  const counts = useMemo(() => countsOf(tasks), [tasks]);
  const clock = useMemo(() => boardClock(tasks, now), [tasks, now]);
  const composeRef = useRef(compose);
  const openRef = useRef(open);
  const recoverRef = useRef(recover);
  useEffect(() => { composeRef.current = compose; openRef.current = open; recoverRef.current = recover; });
  const openOwner = useCallback(address => openRef.current(address), []);
  const message = useCallback(id => composeRef.current(id), []);
  const recoverTask = useCallback((id, harness) => recoverRef.current?.(id, harness), []);
  const task = taskId && tasks.find(item => item.id === taskId);
  const waiting = useMemo(() => sortTasks(tasks.filter(item => item.question && !item.question.answer)), [tasks]);
  return <section aria-label="Task board" className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 py-4">
    {board?.error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">Task store is invalid: {board.error}</p>}
    {taskId ? <>
      <Button type="button" size="sm" variant="outline" className="self-start" onClick={back}>Back to board</Button>
      {task?.question && !task.question.answer && decide && <ul><Decision task={task} decide={decide} compose={message} fullId/></ul>}
      {task ? <Column status={task.status} list={[task]} fullId now={clock} compose={message} open={openOwner} continuation={continuation} recover={recover && recoverTask}/>
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
            aria-pressed={filter === status} className="h-8 rounded-full capitalize" onClick={() => {
              views.set(filterKey, status === "all" ? "" : status);
              setFilter(status);
            }}>
            {status === "all" ? "All" : statusLabel(status)} · {status === "all" ? tasks.length : counts[status]}
          </Button>)}
        </div>
        <div className="flex flex-col gap-4 md:grid md:grid-cols-5 md:items-start">
          {columns.map(([status, list]) => <Column key={status} status={status} list={list} now={clock} compose={message} open={openOwner} continuation={continuation} recover={recover && recoverTask}/>)}
        </div>
      </>}
    </>}
  </section>;
}
