"use client";
// A thread's sessions in the sidebar: lead, children and subagent runs, live or finished; gone sessions stay and open their history.
import { useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isLive, sessionState } from "@/lib/session-state";
import { runState } from "@/lib/activity-rows";
import { agentDetail } from "@/lib/agent-detail";
import { shortName, type Agent } from "@/lib/thread-groups";
import { HarnessMark } from "./agent-mark";
import { Dot, ago, short } from "./chat-shared";

type Run = { id: string; run?: string; kind?: string; description?: string; steps?: number; time?: number; lastTime?: number; done?: boolean; child?: boolean };
type Selected = { level: string; session?: string; run?: string };
export type OpenSession = (session: string, run?: string) => void;

const ROW = "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 text-left hover:bg-sidebar-accent";

/** A session the thread lists but the server no longer knows: only its address remains. */
export function missingSession(id: string): Agent {
  return { id, peer: id.split("#")[0], gone: true, missing: true };
}

/** The sessions under a thread, children nested under their parent; every row opens its session. */
export function SessionTree({ sessions, all, label, title, selected, now, open }: {
  sessions: Agent[]; all: Agent[]; label: string; title?: string; selected: Selected; now: number; open: OpenSession;
}) {
  const listed = new Set(sessions.map(agent => agent.id));
  const roots = sessions.filter(agent => !agent.parent || !listed.has(String(agent.parent)));
  const childrenOf = (id: string) => all.filter(agent => agent.parent === id && agent.id !== id);
  const node = (agent: Agent, depth: number): React.ReactNode => <SessionItem key={agent.id} agent={agent} name={shortName(agent, title)} selected={selected} now={now} open={open}>
    {depth < 3 && childrenOf(agent.id).map(child => node(child, depth + 1))}
  </SessionItem>;
  return <ul aria-label={label} className="ml-3 flex flex-col gap-px pl-1">{roots.map(agent => node(agent, 0))}</ul>;
}

/** One session: live dot, harness mark, name, its state, "model · where", then its subagent runs and children. */
function SessionItem({ agent, name, selected, now, open, children }: {
  agent: Agent; name: string; selected: Selected; now: number; open: OpenSession; children?: React.ReactNode;
}) {
  const state = sessionState(agent, now);
  const live = !agent.gone && (isLive(agent, now) || Boolean(agent.online));
  const current = selected.level === "session" && selected.session === agent.id;
  const detail = agentDetail(agent);
  const runs = ((agent.subagents || []) as Run[]).filter(run => !run.child);
  const finished = (agent.finishedSubagents || []) as Run[];
  const kids = Array.isArray(children) ? children.filter(Boolean) : [];
  return <li className="flex min-w-0 flex-col">
    <button type="button" data-session={agent.id} data-gone={agent.gone ? "true" : undefined} aria-current={current ? "page" : undefined} onClick={() => open(agent.id)}
      title={agent.gone ? "Ended: opens its history" : agent.id}
      className={cn(ROW, "py-1 max-md:py-2", current ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground", agent.gone && "opacity-70")}>
      <span className="mt-1.5 flex shrink-0"><Dot online={live}/></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <HarnessMark peer={String(agent.peer || agent.id.split("#")[0])}/>
          <span className={cn("min-w-0 flex-1 truncate", current || live ? "text-foreground" : "")}>{name || short(agent.id)}</span>
          {agent.gone ? <span className="shrink-0 text-xs">ended</span>
            : state === "waiting" || state === "afk" ? <span className="shrink-0 text-xs font-medium text-primary">waiting</span>
            : state === "working" ? <span className="shrink-0 text-xs text-foreground">working</span>
            : !live && agent.lastMessageAt ? <span className="shrink-0 text-xs">{ago(agent.lastMessageAt, now)}</span> : null}
        </span>
        {detail && <span className="min-w-0 truncate text-xs text-muted-foreground" title={detail}>{detail}</span>}
      </span>
    </button>
    {(runs.length > 0 || finished.length > 0 || kids.length > 0) && <ul aria-label={"Inside " + (name || short(agent.id))} className="ml-3 flex flex-col gap-px pl-1">
      {runs.map(run => <RunItem key={run.id} run={run} now={now} current={current && selected.run === run.run} onOpen={() => open(agent.id, run.run)}/>)}
      {kids}
      {finished.length > 0 && <FinishedRuns runs={finished} now={now} selected={current ? selected.run : undefined} onOpen={run => open(agent.id, run)}/>}
    </ul>}
  </li>;
}

/** Finished runs fold behind one row so a busy session does not push the threads below off screen. */
function FinishedRuns({ runs, now, selected, onOpen }: { runs: Run[]; now: number; selected?: string; onOpen: (run?: string) => void }) {
  const [open, setOpen] = useState(runs.some(run => run.run === selected));
  return <li className="flex min-w-0 flex-col">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(ROW, "items-center py-0.5 text-xs text-muted-foreground max-md:py-2")}>
      <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")}/>
      {runs.length} finished {runs.length === 1 ? "subagent" : "subagents"}
    </button>
    {open && <ul className="flex flex-col gap-px">
      {runs.map(run => <RunItem key={run.id} run={run} now={now} current={selected === run.run} onOpen={() => onOpen(run.run)}/>)}
    </ul>}
  </li>;
}

/** One subagent run: a spinner while it runs, its kind and task, and its step count. */
function RunItem({ run, now, current, onOpen }: { run: Run; now: number; current: boolean; onOpen: () => void }) {
  const running = !run.done && runState(run, now) === "running";
  return <li>
    <button type="button" data-run={run.run} aria-current={current ? "page" : undefined} onClick={onOpen} title={run.description || run.kind}
      className={cn(ROW, "items-center py-0.5 text-xs max-md:py-2", current ? "bg-sidebar-accent text-foreground" : "text-muted-foreground")}>
      {running ? <LoaderCircle aria-label="Running" className="size-3 shrink-0 animate-spin text-live motion-reduce:animate-none"/>
        : <span aria-hidden className="mx-0.5 size-2 shrink-0 rounded-full border border-muted-foreground/60"/>}
      <span className="min-w-0 flex-1 truncate"><span className={running ? "text-foreground" : ""}>{run.kind || "agent"}</span>{run.description && " · " + run.description}</span>
      {(run.steps || 0) > 0 && <span className="shrink-0 tabular-nums">{run.steps}</span>}
    </button>
  </li>;
}
