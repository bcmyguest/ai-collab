"use client";
// A thread's sessions in the sidebar: lead, children and subagent runs, live or finished; gone sessions stay and open their history.
import { useState } from "react";
import { Bell, BellOff, ChevronRight, CircleStop } from "lucide-react";
import { Toggle } from "@ui-sdk/react/toggle";
import { cn } from "@/lib/utils";
import { canStop, isLive, sessionState } from "@/lib/session-state";
import { runState, subagentModel } from "@/lib/activity-rows";
import { agentDetail } from "@/lib/agent-detail";
import { shortName, type Agent } from "@/lib/thread-groups";
import { listens, threadRole } from "../../lib/thread-listening";
import { HarnessMark } from "./agent-mark";
import { Dot, ago, short } from "./chat-shared";

type Run = { id: string; agent?: string; run?: string; kind?: string; model?: string; description?: string; steps?: number; time?: number; lastTime?: number; done?: boolean; child?: boolean };
type Selected = { level: string; session?: string; run?: string };
export type OpenSession = (session: string, run?: string) => void;
export type ListenSession = (thread: string, session: string, on: boolean) => void;
/** The thread a tree belongs to, for the listening toggles: its members and stored settings. */
export type ListenThread = { id: string; title?: string; sessions?: string[]; listeners?: { session: string; listening: boolean }[] };
type Listen = { thread: ListenThread; set: ListenSession; disabled?: boolean };

const ROW = "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 text-left hover:bg-sidebar-accent";

/** A session the thread lists but the server no longer knows: only its address remains. */
export function missingSession(id: string): Agent {
  return { id, peer: id.split("#")[0], gone: true, missing: true };
}

/** A session the sidebar shows as live: not gone, and either working now or online. */
function sessionLive(agent: Agent, now: number): boolean {
  return !agent.gone && (isLive(agent, now) || Boolean(agent.online));
}

/** Unfinished runs of one session; child sessions list as sessions of their own. */
function openRuns(agent: Agent): Run[] {
  return ((agent.subagents || []) as Run[]).filter(run => !run.child && !run.done);
}

/** Every agent working under a thread: its live sessions, their live child sessions and their unfinished subagent runs. */
export function workingCount(sessions: Agent[], all: Agent[], now: number): number {
  const seen = new Set<string>();
  const visit = (agent: Agent, depth: number): number => {
    if (seen.has(agent.id) || depth > 3) return 0;
    seen.add(agent.id);
    const kids = all.filter(kid => kid.parent === agent.id && kid.id !== agent.id);
    return (sessionLive(agent, now) ? 1 : 0) + openRuns(agent).length + kids.reduce((sum, kid) => sum + visit(kid, depth + 1), 0);
  };
  return sessions.reduce((sum, agent) => sum + visit(agent, 0), 0);
}

/** The sessions under a thread, children nested under their parent; every row opens its session. */
export function SessionTree({ sessions, all, label, title, selected, now, open, listen, stop }: {
  sessions: Agent[]; all: Agent[]; label: string; title?: string; selected: Selected; now: number; open: OpenSession; listen?: Listen; stop?: (session: string) => void;
}) {
  const listed = new Set(sessions.map(agent => agent.id));
  const roots = sessions.filter(agent => !agent.parent || !listed.has(String(agent.parent)));
  const childrenOf = (id: string) => all.filter(agent => agent.parent === id && agent.id !== id);
  const node = (agent: Agent, depth: number): React.ReactNode => <SessionItem key={agent.id} agent={agent} name={agent.missing ? agent.peer + " session " + agent.id.split("#")[1]?.slice(0, 6) : shortName(agent, title)} selected={selected} now={now} open={open} listen={listen} stop={stop}>
    {depth < 3 && childrenOf(agent.id).map(child => node(child, depth + 1))}
  </SessionItem>;
  return <ul aria-label={label} className="ml-3 flex flex-col gap-px pl-1">{roots.map(agent => node(agent, 0))}</ul>;
}

/** One session: live dot, harness mark, name, its state, "model · where", then its subagent runs and children. */
function SessionItem({ agent, name, selected, now, open, listen, stop, children }: {
  agent: Agent; name: string; selected: Selected; now: number; open: OpenSession; listen?: Listen; stop?: (session: string) => void; children?: React.ReactNode;
}) {
  const state = sessionState(agent, now);
  const live = sessionLive(agent, now);
  const current = selected.level === "session" && selected.session === agent.id;
  const detail = agentDetail(agent);
  const runs = openRuns(agent);
  const finished = (agent.finishedSubagents || []) as Run[];
  const kids = Array.isArray(children) ? children.filter(Boolean) : [];
  return <li className="flex min-w-0 flex-col">
    <div className="flex min-w-0 items-start">
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
    {stop && canStop(agent, now) && <button type="button" aria-label={"Stop " + (name || short(agent.id))} title="Stop this agent's turn" onClick={() => stop(agent.id)}
      className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground max-md:mt-0 max-md:size-11">
      <CircleStop aria-hidden className="size-3.5"/>
    </button>}
    {listen && !agent.gone && <ListenToggle agent={agent} name={name || short(agent.id)} listen={listen}/>}
    </div>
    {(runs.length > 0 || finished.length > 0 || kids.length > 0) && <ul aria-label={"Inside " + (name || short(agent.id))} className="ml-3 flex flex-col gap-px pl-1">
      {runs.map(run => <RunItem key={run.id} run={run} parent={agent} now={now} current={current && selected.run === run.run} onOpen={() => open(agent.id, run.run)}/>)}
      {kids}
      {finished.length > 0 && <FinishedRuns runs={finished} parent={agent} now={now} selected={current ? selected.run : undefined} onOpen={run => open(agent.id, run)}/>}
    </ul>}
  </li>;
}

/** The bell beside a session: on, every thread post reaches it; off, only posts that @mention it (docs/threads.md "Thread channels"). */
function ListenToggle({ agent, name, listen }: { agent: Agent; name: string; listen: Listen }) {
  const { thread, set, disabled } = listen;
  const setting = thread.listeners?.find(item => item.session === agent.id)?.listening;
  const member = (thread.sessions || []).includes(agent.id);
  const on = listens({ role: threadRole(agent.parent), member, listening: setting ?? null });
  const hint = (on ? "Listening: every post in " : "Muted: only @mentions in ") + (thread.title || "this thread") + (setting === undefined ? " (default)" : "");
  return <Toggle aria-label={"Listen to thread posts: " + name} title={hint} pressed={on} disabled={disabled} data-listen={agent.id}
    onPressedChange={next => set(thread.id, agent.id, next)}
    className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-pressed:text-foreground data-disabled:opacity-50 max-md:mt-0 max-md:size-11">
    {on ? <Bell aria-hidden className="size-3.5"/> : <BellOff aria-hidden className="size-3.5"/>}
  </Toggle>;
}

/** Finished runs fold behind one row so a busy session does not push the threads below off screen. */
function FinishedRuns({ runs, parent, now, selected, onOpen }: { runs: Run[]; parent: Agent; now: number; selected?: string; onOpen: (run?: string) => void }) {
  const [open, setOpen] = useState(runs.some(run => run.run === selected));
  return <li className="flex min-w-0 flex-col">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(ROW, "items-center py-0.5 text-xs text-muted-foreground max-md:py-2")}>
      <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")}/>
      {runs.length} finished {runs.length === 1 ? "subagent" : "subagents"}
    </button>
    {open && <ul className="flex flex-col gap-px">
      {runs.map(run => <RunItem key={run.id} run={run} parent={parent} now={now} current={selected === run.run} onOpen={() => onOpen(run.run)}/>)}
    </ul>}
  </li>;
}

/** One subagent run: a live dot until it finishes, its kind and task, and its step count. */
function RunItem({ run, parent, now, current, onOpen }: { run: Run; parent: Agent; now: number; current: boolean; onOpen: () => void }) {
  const running = !run.done && runState(run, now) === "running";
  const model = subagentModel(run, parent);
  return <li>
    <button type="button" data-run={run.run} data-running={running ? "true" : undefined} aria-current={current ? "page" : undefined} onClick={onOpen} title={run.description || run.kind}
      className={cn(ROW, "items-center py-0.5 text-xs max-md:py-2", current ? "bg-sidebar-accent text-foreground" : "text-muted-foreground")}>
      <Dot online={!run.done}/>
      <HarnessMark peer={String(parent.peer || parent.id.split("#")[0])} className="size-3.5"/>
      <span className="min-w-0 flex-1 truncate"><span className={running ? "text-foreground" : ""}>{run.kind || "agent"}</span>{model && <span data-model> · {model}</span>}{run.description && " · " + run.description}</span>
      {(run.steps || 0) > 0 && <span className="shrink-0 tabular-nums">{run.steps}</span>}
    </button>
  </li>;
}
