"use client";
import { Bot, ChevronRight, CircleHelp, CornerLeftUp, LoaderCircle, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STATE_LABELS, sessionTree } from "@/lib/session-state";
import { runState, subagentLabel } from "@/lib/activity-rows";
import { SUBAGENT_LABELS, subagentState } from "@/lib/subagent-state";
import { pendingLabel } from "@/lib/pending-summary";
import { contextMeter } from "@/lib/context-view";
import { ActivityRow, GoToAgent } from "./activity";
import { ApprovalCard, QuestionCard } from "./cards";
import { Avatar, ago } from "./chat";

const SUBAGENT_DOT = { running: "bg-emerald-500", finished: "bg-muted-foreground/40", stale: "bg-amber-500" };
const CHIP = {
  waiting: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  afk: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  working: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  idle: "border-border bg-muted text-muted-foreground",
  offline: "border-dashed border-border bg-transparent text-muted-foreground",
};
const GROUPS = [["waiting", "Waiting on you"], ["afk", "AFK hold"], ["working", "Working"], ["idle", "Idle"], ["offline", "Offline"]];
const short = address => address?.includes("#") ? address.slice(0, address.indexOf("#") + 9) : address;

export function StateChip({ state }) {
  return <span data-chip={state} className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium", CHIP[state])}>
    {state === "working" && <LoaderCircle className="size-3 animate-spin"/>}{STATE_LABELS[state]}
  </span>;
}

function Action({ action }) {
  if (!action) return null;
  return <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
    {action.subagent && <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">{action.subagent}</Badge>}
    <span className="shrink-0 font-medium text-foreground">{action.tool}</span>
    <span className="min-w-0 flex-1 truncate font-mono">{action.summary}</span>
  </p>;
}

/** A session's actions menu; Dispose waits until the session is offline and registered. */
export function SessionMenu({ node, disabled, dispose, raw, map, label = "Actions for " + node.id }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={label}><MoreHorizontal className="size-4"/></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {raw && <DropdownMenuItem onSelect={() => raw(node)}>Raw activity</DropdownMenuItem>}
      {map && <DropdownMenuItem onSelect={() => map(node)}>Compaction map</DropdownMenuItem>}
      <DropdownMenuItem disabled={disabled || node.online || !node.registered} onSelect={() => dispose(node)}>Dispose</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

// One session: identity, state, last action, running subagents, pending cards or their compact count, and nested child sessions.
function SessionCard({ node, now, open, openAddress, act, answer, dispose, raw, disabled, showProject, compact }) {
  const running = node.subagents.filter(run => runState(run, now) === "running");
  const label = running.length ? running.length + " subagent" + (running.length === 1 ? "" : "s") : "";
  const meter = contextMeter(node.context || {});
  return <li data-session={node.id} className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 flex-col gap-1.5 rounded-2xl border bg-card px-3 py-2.5 text-sm shadow-xs">
      <div className="flex min-w-0 items-start gap-1">
      <button type="button" onClick={() => open(node)} aria-label={"Open " + node.id + (node.name ? " · " + node.name : "")}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
        <Avatar address={node.id} className="size-8 text-[11px]"/>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-start gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 break-words font-medium" title={node.name || node.id}>{node.name || short(node.id)}</span>
            <StateChip state={node.state}/>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{short(node.id)}</span>
            {node.where && <span title="Where it runs">· {node.where}</span>}
            {showProject && <span>· {node.project}</span>}
            <span>· active {ago(Math.max(node.seenAt || 0, node.lastActivityAt || 0), now)}</span>
            {meter.text && <span data-context={meter.level} title="Context used"
              className={cn(meter.level === "full" && "text-destructive", meter.level === "warn" && "text-amber-600")}>· context {meter.text}</span>}
            {label && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]" title="Running subagents">{label}</Badge>}
          </span>
        </span>
      </button>
      <GoToAgent onClick={() => open(node)}/>
      {dispose && <SessionMenu node={node} disabled={disabled} dispose={dispose} raw={raw}/>}
      </div>
      {node.parent && <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">started by {short(node.parent)}</span>
        <GoToAgent label={"Go to parent " + node.parent} onClick={() => openAddress(node.parent, node.project)} className="size-6"/>
      </p>}
      <Action action={node.lastAction}/>
      {running.length > 0 && <ul aria-label="Running subagents" className="ml-2 flex flex-col gap-1 border-l pl-3">
        {running.map(run => <li key={run.id} className="flex min-w-0 flex-col text-xs">
          <span className="flex min-w-0 items-center gap-1">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => open(node, run.run)}>
              <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground"/>
              <span className="min-w-0 truncate">{run.kind || "agent"} · {run.steps} {run.steps === 1 ? "step" : "steps"}{run.description && " · " + run.description}</span>
            </button>
            <GoToAgent label={"Go to subagent " + (run.kind || "agent")} onClick={() => open(node, run.run)} className="size-6"/>
          </span>
          {run.last && <span className="min-w-0 truncate pl-4 font-mono text-muted-foreground">{run.last.tool} {run.last.summary}</span>}
        </li>)}
      </ul>}
      {compact && node.pending.length > 0 && <button type="button" data-pending-count={node.pending.length} onClick={() => open(node)}
        className={cn("flex h-7 w-fit max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium", CHIP.waiting)}>
        <CircleHelp className="size-3.5 shrink-0"/><span className="min-w-0 truncate">{pendingLabel(node.pending)}</span>
      </button>}
      {!compact && node.pending.map(item => <div key={item.id} className="min-w-0">
        {item.kind === "Approval" ? <ApprovalCard approval={item.approval} now={now} disabled={disabled} act={payload => act({ ...payload, project: item.project })}/>
          : <QuestionCard question={item.question} body={item.body} answer={item.answer} disabled={disabled} onAnswer={body => answer(item.project, item.question, body)}/>}
      </div>)}
    </div>
    {node.children.length > 0 && <ul aria-label={"Started by " + short(node.id)} className="ml-4 flex flex-col gap-2 border-l pl-3">
      {node.children.map(child => <SessionCard key={child.project + child.id} node={child} now={now} open={open} openAddress={openAddress} act={act} answer={answer} dispose={dispose} raw={raw} disabled={disabled} showProject={showProject} compact={compact}/>)}
    </ul>}
  </li>;
}

/** Session cards grouped Waiting on you, AFK hold, Working, Idle, then Offline collapsed; compact cards show a pending count instead of the cards. */
export function SessionList({ sessions, now, open, openAddress, act, answer, dispose, raw, disabled, showProject, compact, empty, offlineOpen, onOfflineToggle }) {
  const tree = sessionTree(sessions || [], now);
  if (!tree.length) return <p className="py-16 text-center text-sm text-muted-foreground">{empty}</p>;
  const card = node => <SessionCard key={node.project + node.id} node={node} now={now} open={open} openAddress={openAddress} act={act} answer={answer} dispose={dispose} raw={raw} disabled={disabled} showProject={showProject} compact={compact}/>;
  return <div className="flex min-w-0 flex-col gap-5">
    {GROUPS.map(([group, title]) => {
      const list = tree.filter(node => node.group === group);
      if (!list.length) return null;
      const body = <ul className="flex flex-col gap-2">{list.map(card)}</ul>;
      if (group === "offline") return <details key={group} data-group={group} className="group" open={offlineOpen} onToggle={event => onOfflineToggle?.(event.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90"/>{title} · {list.length}
        </summary>{body}
      </details>;
      return <section key={group} data-group={group} aria-label={title}>
        <h2 className="pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title} · {list.length}</h2>{body}
      </section>;
    })}
  </div>;
}

/** A session's subagent runs; picking one shows only that run's rows. */
export function SubagentList({ rows, session, run, pick, when, now, back, childRuns = [], openChild }) {
  const runs = rows.filter(row => row.type === "subagent" && row.agent === session);
  const chosen = run && runs.find(row => row.run === run);
  if (chosen) return <div className="flex min-w-0 flex-col gap-3" data-run={chosen.run}>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" className="h-8 rounded-full" onClick={back}><CornerLeftUp/>Back to parent</Button>
      <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => pick("")}>All subagents</button>
    </div>
    <p className="text-sm font-medium">{subagentLabel(chosen, now)}{chosen.description && " · " + chosen.description}</p>
    {chosen.rows.map(item => <ActivityRow key={item.id} row={item} when={when}/>)}
  </div>;
  if (!runs.length && !childRuns.length) return <p className="py-16 text-center text-sm text-muted-foreground">{run ? "That subagent run is not in the recent activity." : "No subagents in the recent activity."}</p>;
  const children = <ul aria-label="Child sessions" className="flex min-w-0 flex-col gap-2">
    {childRuns.map(child => <li key={child.id}>
      <button type="button" onClick={() => openChild(child)} className="flex w-full min-w-0 items-start gap-2.5 rounded-2xl border bg-card px-3 py-2.5 text-left text-sm shadow-xs">
        <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 font-medium">{child.kind} · {short(child.id)} · {child.online ? "online" : "offline"}</span>
          {child.description && <span className="min-w-0 truncate text-xs text-muted-foreground">{child.description}</span>}
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>
      </button>
    </li>)}
  </ul>;
  if (!runs.length) return children;
  return <div className="flex min-w-0 flex-col gap-4">
  {childRuns.length > 0 && children}
  <ul aria-label="Subagents" className="flex min-w-0 flex-col gap-2">
    {[...runs].reverse().map(row => <li key={row.id}>
      <button type="button" onClick={() => pick(row.run)} className="flex w-full min-w-0 items-start gap-2.5 rounded-2xl border bg-card px-3 py-2.5 text-left text-sm shadow-xs">
        {runState(row, now) === "running" ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"/> : <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", SUBAGENT_DOT[subagentState(row, now)])}/>
            <span className="shrink-0">{SUBAGENT_LABELS[subagentState(row, now)]}</span>
          </span>
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{subagentLabel(row, now)}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{row.description ? row.description + " · " : ""}started {when(row.time * 1000)}</span>
          {row.last && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.last.tool} {row.last.summary}</span>}
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>
      </button>
    </li>)}
  </ul>
  </div>;
}
