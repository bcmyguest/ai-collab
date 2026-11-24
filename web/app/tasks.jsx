"use client";
import { OutcomeCards } from "./outcomes";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ageOf, boardClock, columnsOf, countsOf, COLUMNS, FILTERS, statusLabel } from "@/lib/task-board";
import { priorityOf, sortTasks } from "../../lib/task-order.mjs";
import { cn } from "@/lib/utils";
import { views } from "@/lib/view-memory";
import { TaskGraph } from "./task-graph";

const DOT = { open: "bg-muted-foreground", decided: "bg-sky-500", building: "bg-amber-500", review: "bg-violet-500", blocked: "bg-destructive", done: "bg-emerald-500" };
const PRIORITY_BADGE = {
  P0: "border-destructive/40 bg-destructive/10 text-destructive",
  P1: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  P2: "border-border bg-muted text-muted-foreground",
  P3: "border-border bg-transparent text-muted-foreground/70",
};
const VIEWS = [["board", "Board"], ["graph", "Graph"]];
const CARD = "flex w-full min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-3 text-left text-sm";
const LAZY = "[content-visibility:auto] [contain-intrinsic-size:auto_7rem]";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A review card's one-line packet: the submitted commit, how much it changed, and whether the branch has moved.
 * The detail view (ReviewTask) is where the verdict is given.
 */
function ReviewLine({ review }) {
  const decision = review.decision;
  const changed = [review.insertions ? `+${review.insertions}` : "", review.deletions ? `−${review.deletions}` : ""].filter(Boolean).join(" ");
  return <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
    <span className="font-mono">{String(review.commit).slice(0, 7)}</span>
    {changed && <span className="font-mono">{changed}</span>}
    <span>{plural(review.files?.length ?? 0, "file")}{review.more > 0 && ` +${review.more}`}</span>
    {review.check?.code !== 0 && <span className="text-destructive">check failed</span>}
    {decision ? <span>{decision.action === "accept" ? "accepted" : "returned"}</span>
      : review.stale ? <span className="text-amber-600 dark:text-amber-400">branch moved</span>
        : <span className="text-violet-600 dark:text-violet-400">waiting for you</span>}
  </p>;
}

/**
 * The verdict on a completed build, shown for a task in review: what it was asked to do, the host check, the diff
 * link and the two decisions. Return needs a one-line note so the next build knows what to change.
 */
function ReviewTask({ task, review, decide }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decided = review.decision;
  const send = async (decision, text) => {
    if (busy) return;
    setBusy(true);
    try { if (await decide(task.id, decision, text, { commit: review.commit, submission: review.submission })) setNote(""); }
    finally { setBusy(false); }
  };
  return <li className="flex min-w-0 flex-col gap-2 rounded-xl border border-violet-500/50 bg-violet-500/5 p-3 text-sm">
    <TaskMetadata task={task} fullId/>
    <p className="font-medium leading-snug wrap-break-word">{task.title}</p>
    {review.criteria && <p className="text-xs text-muted-foreground break-words">Asked for: {review.criteria}</p>}
    <ReviewLine review={review}/>
    <p className="text-xs text-muted-foreground">
      <span className="font-mono">{String(review.commit).slice(0, 12)}</span> on <span className="font-mono">{review.branch}</span>
      {" · "}<a className="underline" href={review.diff} target="_blank" rel="noreferrer">View the diff</a>
    </p>
    {review.check?.text && <p className="rounded border bg-background/60 p-2 font-mono text-xs break-words">{review.check.text}</p>}
    {decided ? <p className="text-xs">
      <span className="text-muted-foreground">{decided.action === "accept" ? "Accepted" : "Returned"} by </span>
      <span className="font-mono">{decided.by}</span>
      {decided.note && <span className="text-muted-foreground"> — {decided.note}</span>}
    </p> : review.stale ? <p className="text-xs text-amber-600 dark:text-amber-400">
      The branch moved past this commit, so this packet can no longer be decided. Queue the task for a fresh build.
    </p> : <>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); send("return", note); }}>
        <input value={note} onChange={event => setNote(event.target.value)} maxLength={500} aria-label={`Return note for ${task.title}`}
          placeholder="What should change?" enterKeyHint="send" disabled={busy}
          className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
        <Button type="submit" size="sm" variant="outline" className="h-9" disabled={busy || !note.trim()}>Return</Button>
      </form>
      <Button type="button" size="sm" className="h-9 self-start" disabled={busy} onClick={() => send("accept")}>Accept build</Button>
    </>}
  </li>;
}


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

function CompactCard({ task, age, inspect, move, dragStart }) {
  return <li className="min-w-0 rounded-xl border bg-card p-2">
    <button type="button" className="flex w-full min-w-0 flex-col gap-1 text-left hover:underline" onClick={() => inspect(task.id)}>
      <TaskMetadata task={task}/>
      <span className="line-clamp-2 text-sm font-medium wrap-anywhere">{task.title}</span>
      {task.review && <ReviewLine review={task.review}/>}
    </button>
    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{task.owner || task.builderUnit || "No owner"}{age && ` · ${age} ago`}</span>
      <select aria-label={`Move ${task.title}`} className="max-w-24 rounded border bg-background p-1 capitalize"
        value={task.status} onChange={event => move(task, event.target.value)}>
        {COLUMNS.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
      </select>
      {dragStart && <span aria-hidden className="cursor-grab touch-none select-none px-2 py-1 text-base"
        onPointerDown={event => dragStart(event, task)}>⠿</span>}
    </div>
  </li>;
}

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

function Decision({ task, decide, skip, compose, fullId }) {
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
    <p className="wrap-anywhere">{q.text}</p>
    <p className="text-xs text-muted-foreground">asked by <span className="font-mono">{q.by}</span></p>
    {q.options?.length > 0 && <div role="group" aria-label="Choices" className="grid gap-2">
      {q.options.map(option => <Button key={option} type="button" size="sm" variant="outline" disabled={busy}
        className="h-auto min-h-11 min-w-0 justify-start rounded-lg py-2 text-left text-sm whitespace-normal" onClick={() => send(option)}>
        <span className="min-w-0 wrap-anywhere">{option}</span>
      </Button>)}
    </div>}
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); send(text); }}>
      <input value={text} onChange={event => setText(event.target.value)} maxLength={500} aria-label={`Answer for ${task.title}`}
        placeholder={q.options?.length ? "Or type your own answer" : "Your decision"} enterKeyHint="send"
        className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
      <Button type="submit" size="sm" className="h-9" disabled={busy || !text.trim()}>Decide</Button>
      {skip && <Button type="button" size="sm" variant="ghost" className="h-9 text-muted-foreground" disabled={busy}
        onClick={async () => { setBusy(true); await skip(task.id); setBusy(false); }}>Skip</Button>}
    </form>
  </li>;
}

const Column = memo(function Column({ status, list, now, compose, open, fullId, continuation, recover, inspect, move, dragStart, collapsed, toggle, target }) {
  const heading = <>
    <span aria-hidden className={cn("inline-block size-2 rounded-full", DOT[status])}/>{statusLabel(status)} · {list.length}
  </>;
  return <section aria-label={status} data-task-column={status} className={cn("flex min-w-0 flex-col gap-2",
    !fullId && "min-h-0 snap-start rounded-xl border bg-muted/30 p-2", target && "ring-2 ring-inset ring-primary")}>
    <h2 className="flex shrink-0 items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {toggle ? <button type="button" aria-expanded={!collapsed} onClick={toggle}
        className="flex w-full items-center gap-2 py-1 uppercase">
        {heading}<span aria-hidden className="ml-auto">{collapsed ? "+" : "−"}</span>
      </button> : heading}
    </h2>
    {!collapsed && (list.length ? <ul className={cn("flex flex-col gap-2", !fullId && "min-h-0 overflow-y-auto overscroll-y-contain")}>{list.map(task => {
      const age = task.last ? ageOf(task.last.at, now) : "";
      return fullId
        ? <Card key={task.id} task={task} age={age} compose={compose} open={open} fullId continuation={continuation} recover={recover}/>
        : <CompactCard key={task.id} task={task} age={age} inspect={inspect} move={move} dragStart={dragStart}/>;
    })}</ul> : <p className="text-xs text-muted-foreground">No {statusLabel(status)} tasks.</p>)}
  </section>;
});

export function TaskBoard({ project, board, now, open, compose, decide, skip, review: decideReview, taskId, back, continuation, recover, inspect, move, landControl, outcomeControls }) {
  const filterKey = "task filter " + project;
  const [filter, setFilter] = useState(() => views.get(filterKey, "all"));
  const [view, setView] = useState("board");
  const [doneOpen, setDoneOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const lane = useRef(null);
  const stopDrag = useRef(null);
  const moving = useRef(new Set());
  useEffect(() => () => stopDrag.current?.(), [filter, taskId, view]);

  const moveRef = useRef(move);
  const inspectRef = useRef(inspect);
  useEffect(() => { moveRef.current = move; inspectRef.current = inspect; });
  const inspectTask = useCallback(id => inspectRef.current(id), []);
  const toggleDone = useCallback(() => setDoneOpen(value => !value), []);

  const moveCard = useCallback(async (task, status) => {
    if (status === task.status || moving.current.has(task.id)) return;
    moving.current.add(task.id);
    try { await moveRef.current(task.id, status); }
    finally { moving.current.delete(task.id); }
  }, []);

  const dragStart = useCallback((event, task) => {
    if (!event.isPrimary || event.button !== 0 || stopDrag.current) return;
    const rail = lane.current;
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    let { clientX: x, clientY: y } = event;
    const columnAt = () => {
      const column = document.elementFromPoint(x, y)?.closest("[data-task-column]");
      return rail.contains(column) ? column.dataset.taskColumn : null;
    };
    const track = next => {
      x = next.clientX;
      y = next.clientY;
      setTarget(columnAt());
    };
    const timer = window.setInterval(() => {
      const bounds = rail.getBoundingClientRect();
      if (y < bounds.top || y > bounds.bottom) return;
      if (x >= bounds.left && x < bounds.left + 32) rail.scrollLeft -= 14;
      else if (x <= bounds.right && x > bounds.right - 32) rail.scrollLeft += 14;
      setTarget(columnAt());
    }, 30);
    const stop = () => {
      window.clearInterval(timer);
      handle.removeEventListener("pointermove", track);
      handle.removeEventListener("pointerup", drop);
      handle.removeEventListener("lostpointercapture", stop);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      delete rail.dataset.dragging;
      stopDrag.current = null;
      setTarget(null);
    };
    const drop = next => {
      track(next);
      const status = columnAt();
      stop();
      if (status) moveCard(task, status);
    };
    stopDrag.current = stop;
    rail.dataset.dragging = "true";
    handle.setPointerCapture(pointer);
    handle.addEventListener("pointermove", track);
    handle.addEventListener("pointerup", drop);
    handle.addEventListener("lostpointercapture", stop);
  }, [moveCard]);

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
  return <section aria-label="Task board" className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 px-3 py-4",
    taskId ? "max-w-6xl overflow-y-auto overscroll-contain" : "overflow-hidden")}>
    {board?.error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">Task store is invalid: {board.error}</p>}
    {taskId ? <>
      <Button type="button" size="sm" variant="outline" className="self-start" onClick={back}>Back to board</Button>
      {task?.question && !task.question.answer && decide && <ul><Decision task={task} decide={decide} skip={skip} compose={message} fullId/></ul>}
      {task?.review && decideReview && <ul><ReviewTask task={task} review={task.review} decide={decideReview}/></ul>}
      {task ? <Column status={task.status} list={[task]} fullId now={clock} compose={message} open={openOwner} continuation={continuation} recover={recover && recoverTask}/>
        : board && !board.error && <p role="status">Task #{taskId} was not found.</p>}
    </> : <>
      <div className="flex max-h-[30dvh] shrink-0 flex-col gap-4 overflow-y-auto overscroll-y-contain empty:hidden">
        {landControl}
        {outcomeControls && <OutcomeCards outcomes={board?.outcomes} tasks={tasks} inspect={inspect} controls={outcomeControls}/>}
        {waiting.length > 0 && decide && <section aria-label="Needs your decision" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
            <span aria-hidden className="inline-block size-2 rounded-full bg-amber-500"/>Needs you · {waiting.length}
          </h2>
          <ul className="flex flex-col gap-2 md:grid md:grid-cols-2">{waiting.map(item => <Decision key={item.id} task={item} decide={decide} skip={skip} compose={message}/>)}</ul>
        </section>}
      </div>
      <div role="group" aria-label="View" className="flex shrink-0 gap-2">
        {VIEWS.map(([id, name]) => <Button key={id} type="button" size="sm" variant={view === id ? "default" : "outline"}
          aria-pressed={view === id} className="h-8 rounded-full" onClick={() => setView(id)}>{name}</Button>)}
      </div>
      {view === "graph" ? <TaskGraph tasks={tasks} open={open}/> : <>
        <div role="group" aria-label="Filter by status" className="flex shrink-0 flex-wrap gap-2">
          {FILTERS.map(status => <Button key={status} type="button" size="sm" variant={filter === status ? "default" : "outline"}
            aria-pressed={filter === status} className="h-8 rounded-full capitalize" onClick={() => {
              views.set(filterKey, status === "all" ? "" : status);
              stopDrag.current?.();
              setFilter(status);
              if (lane.current) lane.current.scrollLeft = 0;
            }}>
            {status === "all" ? "All" : statusLabel(status)} · {status === "all" ? tasks.length : counts[status]}
          </Button>)}
        </div>
        <div ref={lane} aria-label="Status columns" tabIndex={filter === "all" ? 0 : undefined}
          className={cn("grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] items-stretch gap-3 pb-2", filter === "all" &&
            "auto-cols-[85%] grid-flow-col snap-x snap-mandatory overflow-x-auto overscroll-x-contain data-[dragging=true]:snap-none sm:auto-cols-[minmax(13rem,1fr)]")}>
          {columns.map(([status, list]) => <Column key={status} status={status} list={list} now={clock}
            inspect={inspectTask} move={moveCard} dragStart={filter === "all" ? dragStart : null} target={target === status}
            collapsed={status === "done" && filter === "all" && !doneOpen}
            toggle={status === "done" && filter === "all" ? toggleDone : undefined}/>)}
        </div>
      </>}
    </>}
  </section>;
}
