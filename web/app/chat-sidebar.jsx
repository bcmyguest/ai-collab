"use client";
// The projects sidebar: brand row, decision inbox, project list, scheduled jobs, agents and session rows.
// Rendered both as the desktop rail and inside the phone's navigation sheet.
import { useTheme } from "next-themes";
import { Coffee, FolderGit2, Monitor, Moon, Plus, Sun, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isLive } from "@/lib/session-state";
import { ScheduledJobs } from "./scheduled";
import { ClosedProjects, ProjectMenu } from "./project-menu";
import { RunningCount, SubagentRuns } from "./subagent-runs";
import { InactiveSessions, SessionMenu } from "./home";
import { namedAgents, unnamedAgents } from "@/lib/sidebar";
import { THREAD_STATUS_LABELS, threadRows } from "@/lib/threads";
import { Avatar, Dot, SessionName, ago, short } from "./chat-shared";

const AFK_MODES = [["off", "Off", Monitor], ["on", "On", Coffee], ["quiet", "Quiet", VolumeX]];

// Operator away mode, broadcast to every project's agents.
export function AfkToggle({ mode, disabled, set }) {
  const Icon = AFK_MODES.find(([id]) => id === mode)?.[2] || Monitor;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant={mode === "off" ? "ghost" : "secondary"} size="sm" className="rounded-full" aria-label={"AFK mode: " + mode} title={"AFK mode: " + mode} disabled={disabled}>
        <Icon/><span className="text-xs">{mode === "off" ? "AFK" : "AFK " + mode}</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      <DropdownMenuLabel>AFK mode · all projects</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode} onValueChange={next => next !== mode && set(next)}>
        {AFK_MODES.map(([id, label, ItemIcon]) => <DropdownMenuRadioItem key={id} value={id}><ItemIcon/>{label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label="Theme"><Sun className="dark:hidden"/><Moon className="hidden dark:block"/></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
        <DropdownMenuRadioItem value="dark"><Moon/>Dark</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="light"><Sun/>Light</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="system"><Monitor/>System</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

// One session row in the sidebar: its name, address, running count, waiting dot and last activity.
// An agent row leads with its set_identity name; a plain row leads with its address.
function SessionRow({ agent, project, selected, now, navigate, dispose, openRaw, disabled, lead = "address" }) {
  // An agent row leads with the set_identity name, which a later harness title does not replace.
  const name = lead === "name" ? agent.identityName || agent.name : "";
  const label = name || short(agent.id);
  return <li className="flex min-w-0 flex-col gap-1">
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" data-tap aria-label={agent.waiting ? agent.id + ", waiting on you" : agent.id} title={agent.parent ? agent.id + " · started by " + agent.parent : agent.id} aria-current={selected.level === "session" && selected.session === agent.id ? "page" : undefined}
        onClick={() => navigate({ project, level: "session", harness: agent.peer, session: agent.id, ...(selected.level === "session" && selected.session ? { tab: selected.tab } : {}) })}
        className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent",
          selected.level === "session" && selected.session === agent.id && "bg-sidebar-accent")}>
        <Avatar address={agent.id} className="size-6 text-[9px]"/>
        <span className="flex min-w-0 flex-1 flex-col">
          {lead === "name" ? <>
            <span className="truncate font-medium" title={name}>{label}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{short(agent.id)}</span>
          </> : <>
            <span className="truncate font-mono text-xs">{short(agent.id)}</span><SessionName agent={agent}/>
          </>}
          {agent.owner && <span className="truncate text-[11px] text-muted-foreground">@{agent.owner}</span>}
          {agent.team && <span className="truncate text-[11px] text-muted-foreground" title="Team and role">{agent.team} · {agent.role}</span>}
          <span className="self-start"><RunningCount runs={agent.subagents} now={now}/></span>
        </span>
        {agent.waiting && <span role="img" aria-label="Waiting on you" title="Waiting on you" className="inline-block size-2.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/25"/>}
        <Dot online={isLive(agent, now)}/>
        <span className="shrink-0 text-right text-[11px] leading-tight text-muted-foreground">{ago(agent.lastMessageAt, now)}{isLive(agent, now) && agent.activeAt ? <><br/>active {ago(agent.activeAt, now)}</> : null}</span>
      </button>
      {dispose && <SessionMenu node={{ ...agent, project }} disabled={disabled} dispose={dispose} raw={openRaw} map={() => navigate({ project, level: "compactions" })} label={"Session actions for " + agent.id}/>}
    </div>
    {/* An agent's activity line says what it is doing now; the harness title is beside it on the card views. */}
    {lead === "name" && agent.activity && <p className="truncate px-2 text-[11px] text-muted-foreground" title={agent.activity}>{agent.activity}</p>}
    <SubagentRuns runs={agent.subagents} now={now} open={run => navigate({ project, level: "session", harness: agent.peer, session: agent.id, tab: "subagents", run: run.run })}/>
  </li>;
}

// The agents that set a name with set_identity, PM first; a tap opens that session's direct chat.
function AgentList({ agents, project, selected, now, navigate, dispose, openRaw, disabled }) {
  return <section aria-label="Agents">
    <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Agents</h2>
    <ul className="flex flex-col gap-1">
      {agents.map(agent => <SessionRow key={"agent:" + agent.id} agent={agent} project={project} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled} lead="name"/>)}
    </ul>
  </section>;
}

// Threads of this project with their sessions nested; the shown status comes from the live session cards.
function ThreadList({ threads, project, selected, now, navigate, dispose, openRaw, disabled }) {
  return <section aria-label="Threads">
    <h2 className="min-w-0 truncate px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Threads · {project}</h2>
    <ul className="flex flex-col gap-2">
      {threads.map(thread => <li key={thread.id} className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 px-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium" title={thread.worktree || thread.title}>{thread.title || thread.branch || thread.id}</span>
          {thread.pinned && <span className="shrink-0 text-[11px] text-muted-foreground">Pinned</span>}
          <span className={cn("shrink-0 text-[11px]", thread.status === "waiting" ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{THREAD_STATUS_LABELS[thread.status] || thread.status}</span>
        </div>
        {thread.agents.length > 0 && <ul className="flex flex-col gap-1 pl-3">
          {thread.agents.map(agent => <SessionRow key={thread.id + ":" + agent.id} agent={agent} project={project} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled} lead={agent.identityName ? "name" : undefined}/>)}
        </ul>}
      </li>)}
    </ul>
  </section>;
}

export function Sidebar({ data, selected, now, navigate, newSession, dispose, openRaw, disabled, projectAction, openHash, inactiveOpen, onInactiveToggle }) {
  const current = selected.project || data.project;
  // Home's state carries the server's default project's agents; they are not "this project" here.
  const home = selected.level === "home" || selected.level === "inbox";
  const visible = home ? [] : data.agents.filter(agent => !agent.gone);
  const active = [];
  const inactive = [];
  for (const agent of visible) {
    const group = isLive(agent, now) ? active : inactive;
    group.push(agent);
  }
  const threads = home ? [] : threadRows(data.threads, visible, now);
  return <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4">
    <button type="button" data-tap onClick={() => navigate({ level: "home" })} aria-current={selected.level === "home" ? "page" : undefined}
      className="flex items-center gap-2 rounded-xl px-2 text-left text-sm font-semibold tracking-tight" title="Home: every project's sessions">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">ai</span>AI Collab
    </button>
    <Button variant="ghost" className="justify-start" onClick={() => navigate({ level: "inbox" })} aria-current={selected.level === "inbox" ? "page" : undefined}>Decision inbox</Button>
    <section>
      <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Projects</h2>
      <ul className="flex flex-col gap-1">
        {data.projects.map(project => <li key={project.id} className="flex items-center gap-1">
          <button type="button" data-tap aria-current={project.id === current ? "page" : undefined}
            onClick={() => navigate({ project: project.id, level: "project" })}
            className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent",
              project.id === current && "bg-sidebar-accent font-medium")}>
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground"/>
            <span className="min-w-0 flex-1 truncate">{project.id}</span>
            {project.waiting > 0 && <span className="shrink-0 rounded-full border border-amber-500/60 bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              aria-label={project.waiting + " waiting on you"} title="Sessions waiting on you">{project.waiting}</span>}
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" title={data.projectCounts?.[project.id] ? data.projectCounts[project.id].running + " running · " + data.projectCounts[project.id].inactive + " inactive" : undefined}>{data.projectCounts?.[project.id] ? data.projectCounts[project.id].running + " ▶ · " + data.projectCounts[project.id].inactive + " off" : ""}</span>
          </button>
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" aria-label={"New session in " + project.id}
            disabled={disabled || project.paused} title="New session" onClick={() => newSession(project.id)}><Plus/></Button>
          {!data.autoProjects?.includes(project.id) && <ProjectMenu project={project.id} act={projectAction}/>}
        </li>)}
      </ul>
      {data.closedProjects?.length > 0 && <div className="pt-4"><ClosedProjects names={data.closedProjects} act={projectAction}/></div>}
    </section>
    {/* Scheduled jobs are the runner's own entries, not agents: they stay in their own section below. */}
    <ScheduledJobs project={home ? "" : current} openRun={openHash}/>
    {/* Agents (sessions that set an identity name) sit apart from the plain session rows and from Scheduled jobs. */}
    {!home && namedAgents(active).length > 0 && <AgentList agents={namedAgents(active)} project={current} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled}/>}
    {threads.length > 0 && <ThreadList threads={threads} project={current} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled}/>}
    <section>
      <div className="flex items-center justify-between px-2 pb-2">
        <h2 className="min-w-0 truncate text-xs font-medium uppercase tracking-wider text-muted-foreground" title={home ? undefined : current}>{home ? "Sessions" : "Sessions · " + current}</h2>
        <button type="button" data-tap onClick={() => navigate(home ? { level: "home" } : { project: current, level: "session" })}
          aria-current={home || (selected.level === "session" && !selected.session) ? "page" : undefined}
          className="shrink-0 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">All sessions</button>
      </div>
      {home ? <p className="px-2 text-sm text-muted-foreground">Pick a project to list its sessions here.</p>
        : visible.length === 0 && <p className="px-2 text-sm text-muted-foreground">No sessions seen yet.</p>}
      <ul className="flex flex-col gap-1">
        {unnamedAgents(active).map(agent => <SessionRow key={agent.id} agent={agent} project={current} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled}/>)}
      </ul>
      {inactive.length > 0 && <InactiveSessions count={inactive.length} open={inactiveOpen} onToggle={onInactiveToggle}>
        <ul className="flex flex-col gap-1">
          {[...namedAgents(inactive), ...unnamedAgents(inactive)].map(agent => <SessionRow key={agent.id} agent={agent} project={current} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled} lead={agent.identityName ? "name" : undefined}/>)}
        </ul>
      </InactiveSessions>}
    </section>
  </div>;
}
