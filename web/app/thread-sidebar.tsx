"use client";
// The left column: wordmark, project switcher, the project's threads grouped by what they need, and the app menu.
// Rendered beside the chat on a desktop and as the whole screen on a phone.
import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, GitPullRequest, Plus, Settings2 } from "lucide-react";
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuItemIndicator, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from "@ui-sdk/react/menu";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { isLive, sessionState } from "@/lib/session-state";
import { COLLAPSED, GROUPS, elapsed, shortName, threadGroups, threadSession, unthreaded, workingTime, type Agent, type GroupId, type Thread, type ThreadRow } from "@/lib/thread-groups";
import { AgentName, HarnessMark } from "./agent-mark";
import { SessionTree, missingSession, type OpenSession } from "./thread-sessions";
import { ago } from "./chat-shared";
import { Logo } from "./logo";

type Project = { id: string; waiting?: number; paused?: boolean };
type Selected = { level: string; project?: string; session?: string; tab?: string };
type Navigate = (next: Record<string, unknown>) => void;
type Data = {
  project?: string; projects: Project[]; agents: Agent[]; threads?: Thread[]; closedProjects?: string[]; autoProjects?: string[];
  decisions?: unknown[]; mode?: string; hosted?: boolean;
};
export type SidebarProps = {
  data: Data; selected: Selected; now: number; navigate: Navigate; ready: boolean; disabled: boolean;
  newThread: (project: string) => void; projectAction: (path: string, name: string) => void;
  counts: { tasks: number; waiting: number; patterns: number }; decisions: number;
  pause: () => void; openSchedules: () => void; signOut?: () => void; account?: string;
  controls?: ReactNode;
};

const MENU = "z-50 min-w-56 rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-raised outline-none";
const ITEM = "flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 focus-visible:-outline-offset-2 data-highlighted:bg-accent data-disabled:cursor-default data-disabled:opacity-50 max-sm:min-h-11";
const LABEL = "px-2 pb-1 pt-2 text-xs text-muted-foreground";
const SEP = "my-1 h-px bg-border";
const THEMES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
const PR_TONE = { merged: "text-foreground", open: "text-foreground", draft: "text-muted-foreground", closed: "text-muted-foreground line-through" } satisfies Record<string, string>;

/** The mark and wordmark; together they are the way home. */
function Wordmark({ current, navigate }: { current: boolean; navigate: Navigate }) {
  return <button type="button" data-tap onClick={() => navigate({ level: "home" })} aria-current={current ? "page" : undefined} title="Home: every project"
    className="flex items-center gap-2 rounded-md px-1 text-base font-semibold tracking-tight text-foreground">
    <Logo/><span>ai<span className="text-muted-foreground">-</span>collab</span>
  </button>;
}

/** The project picker: the current project's full name, its waiting count, and every project in the menu. */
function ProjectSwitcher({ data, current, navigate }: { data: Data; current: string; navigate: Navigate }) {
  const waiting = data.projects.reduce((sum, item) => sum + (item.waiting || 0), 0);
  return <Menu presentation="auto">
    <MenuTrigger className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-sidebar-accent data-open:bg-sidebar-accent max-md:min-h-11">
      <span className="min-w-0 flex-1 truncate" title={current || "All projects"}>{current || "All projects"}</span>
      {waiting > 0 && <span className="shrink-0 text-xs font-medium text-primary" aria-label={waiting + " waiting on you"}>{waiting}</span>}
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground"/>
    </MenuTrigger>
    <MenuContent align="start" className={cn(MENU, "max-h-(--available-height) w-(--anchor-width) min-w-64 overflow-y-auto")}>
      <MenuItem className={ITEM} onSelect={() => navigate({ level: "home" })}>
        <span className="flex-1">All projects</span>{!current && <Check aria-hidden className="size-3.5"/>}
      </MenuItem>
      <MenuSeparator className={SEP}/>
      {data.projects.map(project => <MenuItem key={project.id} className={ITEM} onSelect={() => navigate({ project: project.id, level: "project" })}>
        <span className="min-w-0 flex-1 break-all">{project.id}</span>
        {project.paused && <span className="shrink-0 text-xs text-muted-foreground">paused</span>}
        {(project.waiting || 0) > 0 && <span className="shrink-0 text-xs font-medium text-primary">{project.waiting} waiting</span>}
        {project.id === current && <Check aria-hidden className="size-3.5 shrink-0"/>}
      </MenuItem>)}
    </MenuContent>
  </Menu>;
}

function PrBadges({ prs }: { prs?: Thread["prs"] }) {
  if (!prs?.length) return null;
  return <span className="flex shrink-0 items-center gap-1.5">
    {prs.map(pr => <span key={pr.id || pr.number} title={"PR #" + pr.number + " · " + pr.state} data-pr={pr.state}
      className={cn("inline-flex items-center gap-0.5 font-mono text-xs", PR_TONE[pr.state as keyof typeof PR_TONE] || "text-muted-foreground")}>
      <GitPullRequest aria-hidden className="size-3"/>{pr.number}
    </span>)}
  </span>;
}

/** One thread: waiting mark, title, its age or working time, harness marks and PRs, then every session it holds. */
function ThreadItem({ row, all, selected, now, navigate, project }: { row: ThreadRow; all: Agent[]; selected: Selected; now: number; navigate: Navigate; project: string }) {
  const open = selected.level === "session" && Boolean(selected.session) && (row.sessions || []).includes(selected.session || "");
  const target = threadSession(row, row.agents);
  const working = workingTime(row, now);
  const waiting = row.shown === "waiting";
  const go = (session: string) => session ? navigate({ project, level: "session", harness: session.split("#")[0], session, ...(open && selected.tab ? { tab: selected.tab } : {}) })
    : navigate({ project, level: "project" });
  const byId = new Map(all.map(agent => [agent.id, agent]));
  const sessions = (row.sessions || []).map(id => byId.get(id) || missingSession(id));
  const openRun: OpenSession = (session, run) => run
    ? navigate({ project, level: "session", harness: session.split("#")[0], session, tab: "subagents", run })
    : go(session);
  return <li className="flex min-w-0 flex-col">
    <button type="button" data-thread={row.id} aria-current={open ? "true" : undefined} onClick={() => go(target)}
      className={cn("flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent max-md:py-2.5", open && "bg-sidebar-accent/60")}>
      <span className="flex min-w-0 items-center gap-2">
        {waiting && <span role="img" aria-label="Waiting on you" className="size-1.5 shrink-0 rounded-full bg-primary"/>}
        <span className={cn("min-w-0 flex-1 truncate", (open || waiting) && "font-medium")} title={row.title || row.branch || row.id}>{row.title || row.branch || row.id}</span>
        <span className={cn("shrink-0 text-xs tabular-nums", working ? "text-foreground" : "text-muted-foreground")} title={working ? "Working for " + working : undefined}>
          {working || (row.updatedAt ? elapsed(now - row.updatedAt) : "")}
        </span>
      </span>
      {(row.harnesses.length > 0 || (row.prs?.length || 0) > 0 || row.branch) && <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex shrink-0 items-center">{row.harnesses.map(peer => <HarnessMark key={peer} peer={peer} className="size-3.5"/>)}</span>
        {row.branch && <span className="min-w-0 flex-1 truncate font-mono" title={row.branch}>{row.branch}</span>}
        {!row.branch && <span className="flex-1"/>}
        <PrBadges prs={row.prs}/>
      </span>}
    </button>
    {sessions.length > 0 && <SessionTree sessions={sessions} all={all} label={"Sessions in " + (row.title || row.id)} title={row.title} selected={selected} now={now} open={openRun}/>}
  </li>;
}

/** One session outside any thread: glyph, short name, and a waiting or working mark. */
function SessionItem({ agent, name, selected, now, onOpen }: { agent: Agent; name: string; selected: Selected; now: number; onOpen: () => void }) {
  const state = sessionState(agent, now);
  const current = selected.level === "session" && selected.session === agent.id;
  return <li>
    <button type="button" data-session={agent.id} aria-current={current ? "page" : undefined} onClick={onOpen}
      className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent max-md:py-2", current && "font-medium text-foreground", !current && "text-muted-foreground")}>
      <AgentName address={agent.id} name={name} className="flex-1"/>
      {state === "waiting" || state === "afk" ? <span className="shrink-0 text-xs text-primary">waiting</span>
        : state === "working" ? <span className="shrink-0 text-xs text-foreground">working</span>
        : !isLive(agent, now) && agent.lastMessageAt ? <span className="shrink-0 text-xs">{ago(agent.lastMessageAt, now)}</span> : null}
    </button>
  </li>;
}

function Group({ id, label, rows, children }: { id: GroupId | "sessions" | "inactive"; label: string; rows: number; children: ReactNode }) {
  const [open, setOpen] = useState(!COLLAPSED.includes(id as GroupId) && id !== "inactive");
  if (!rows) return null;
  return <section aria-label={label} data-group={id}>
    <h2>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground max-md:py-2">
        <ChevronRight aria-hidden className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")}/>
        <span className={cn(id === "waiting" && "text-primary")}>{label}</span><span className="tabular-nums">{rows}</span>
      </button>
    </h2>
    {open && <ul className="flex flex-col">{children}</ul>}
  </section>;
}

/** The app menu at the sidebar's foot: project views, decisions, schedules, the project's pause switch, theme and account. */
function AppMenu({ data, current, navigate, counts, decisions, pause, openSchedules, projectAction, signOut, account, disabled, ready }: SidebarProps & { current: string }) {
  const { theme, setTheme } = useTheme();
  const project = data.projects.find(item => item.id === current);
  const managed = Boolean(current) && !data.autoProjects?.includes(current);
  return <Menu presentation="auto">
    <MenuTrigger aria-label="Menu" className="flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-open:bg-sidebar-accent max-md:min-h-11">
      <Settings2 aria-hidden className="size-4"/>Menu
      {(decisions > 0 || counts.waiting > 0) && <span className="size-1.5 rounded-full bg-primary" role="img" aria-label="Decisions wait on you"/>}
    </MenuTrigger>
    <MenuContent side="top" align="start" className={cn(MENU, "max-h-(--available-height) overflow-y-auto")}>
      <MenuItem className={ITEM} onSelect={() => navigate({ level: "inbox" })}>
        <span className="flex-1">Decision inbox</span>{decisions > 0 && <span className="text-xs font-medium text-primary">{decisions}</span>}
      </MenuItem>
      {current && <MenuGroup>
        <MenuGroupLabel className={LABEL}>{current}</MenuGroupLabel>
        <MenuItem className={ITEM} onSelect={() => navigate({ project: current, level: "project" })}><span className="flex-1">Project chat</span></MenuItem>
        <MenuItem className={ITEM} onSelect={() => navigate({ project: current, level: "tasks" })}>
          <span className="flex-1">Tasks</span>
          {counts.waiting > 0 ? <span className="text-xs font-medium text-primary">{counts.waiting} to decide</span> : counts.tasks > 0 && <span className="text-xs text-muted-foreground">{counts.tasks}</span>}
        </MenuItem>
        <MenuItem className={ITEM} onSelect={() => navigate({ project: current, level: "patterns" })}>
          <span className="flex-1">Teams</span>{counts.patterns > 0 && <span className="text-xs text-muted-foreground">{counts.patterns}</span>}
        </MenuItem>
        <MenuItem className={ITEM} onSelect={() => navigate({ project: current, level: "session" })}><span className="flex-1">All sessions</span></MenuItem>
        <MenuItem className={ITEM} onSelect={() => navigate({ project: current, level: "compactions" })}><span className="flex-1">History</span></MenuItem>
        {ready && !data.hosted && <MenuItem className={ITEM} disabled={disabled} onSelect={pause}>
          <span className="flex-1">{project?.paused ? "Resume new work" : "Pause new work"}</span>
          {project?.paused && <span className="text-xs text-muted-foreground">paused</span>}
        </MenuItem>}
        {managed && <MenuSub>
          <MenuSubTrigger className={ITEM}><span className="flex-1">Project actions</span><ChevronRight aria-hidden className="size-3.5"/></MenuSubTrigger>
          <MenuSubContent className={MENU}>
            <MenuItem className={ITEM} onSelect={() => projectAction("request-outcome", current)}>Request an outcome</MenuItem>
            <MenuItem className={ITEM} onSelect={() => projectAction("close", current)}>Close project</MenuItem>
            <MenuItem className={cn(ITEM, "text-destructive")} onSelect={() => projectAction("delete", current)}>Delete project</MenuItem>
          </MenuSubContent>
        </MenuSub>}
      </MenuGroup>}
      <MenuSeparator className={SEP}/>
      <MenuItem className={ITEM} onSelect={openSchedules}><span className="flex-1">Scheduled jobs</span></MenuItem>
      {(data.closedProjects?.length || 0) > 0 && <MenuSub>
        <MenuSubTrigger className={ITEM}><span className="flex-1">Closed projects</span><span className="text-xs text-muted-foreground">{data.closedProjects?.length}</span><ChevronRight aria-hidden className="size-3.5"/></MenuSubTrigger>
        <MenuSubContent className={MENU}>
          <MenuGroup>
            <MenuGroupLabel className={LABEL}>Reopen</MenuGroupLabel>
            {data.closedProjects?.map(name => <MenuItem key={name} className={ITEM} onSelect={() => projectAction("reopen", name)}><span className="break-all">{name}</span></MenuItem>)}
          </MenuGroup>
        </MenuSubContent>
      </MenuSub>}
      <MenuSub>
        <MenuSubTrigger className={ITEM}><span className="flex-1">Theme</span><span className="text-xs text-muted-foreground">{theme}</span><ChevronRight aria-hidden className="size-3.5"/></MenuSubTrigger>
        <MenuSubContent className={MENU}>
          <MenuRadioGroup value={theme} onValueChange={(next: unknown) => { if (typeof next === "string") setTheme(next); }}>
            {THEMES.map(([id, label]) => <MenuRadioItem key={id} value={id} className={ITEM}>
              <span className="flex-1">{label}</span><MenuItemIndicator><Check aria-hidden className="size-3.5"/></MenuItemIndicator>
            </MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
      {account && signOut && <>
        <MenuSeparator className={SEP}/>
        <MenuGroup>
          <MenuGroupLabel className={LABEL}>Signed in as {account}</MenuGroupLabel>
          <MenuItem className={ITEM} onSelect={signOut}>Sign out</MenuItem>
        </MenuGroup>
      </>}
    </MenuContent>
  </Menu>;
}

export function ThreadSidebar(props: SidebarProps) {
  const { data, selected, now, navigate, newThread, disabled, controls } = props;
  const home = selected.level === "home" || selected.level === "inbox";
  const current = home ? "" : selected.project || data.project || "";
  const all = home ? [] : data.agents || [];
  const agents = all.filter(agent => !agent.gone);
  const threads = home ? [] : data.threads || [];
  const groups = threadGroups(threads, all, now);
  const loose = unthreaded(agents, threads);
  const live = loose.filter(agent => isLive(agent, now) || agent.online);
  const idle = loose.filter(agent => !(isLive(agent, now) || agent.online));
  const paused = data.projects.some(item => item.id === current && item.paused);
  const sessionRow = (agent: Agent) => <SessionItem key={agent.id} agent={agent} name={shortName(agent)} selected={selected} now={now}
    onOpen={() => navigate({ project: current, level: "session", harness: agent.peer || agent.id.split("#")[0], session: agent.id })}/>;
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex flex-col gap-1 px-2 pb-2 pt-3">
      <div className="flex min-h-9 items-center gap-2 px-1">
        <Wordmark current={selected.level === "home"} navigate={navigate}/>
        {/* The deploy banner ("deployed: <branch>") renders into this slot. */}
        <div data-slot="deploy-banner" className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground empty:hidden"/>
      </div>
      <ProjectSwitcher data={data} current={current} navigate={navigate}/>
      {current && <button type="button" aria-label={"New thread in " + current} onClick={() => newThread(current)} disabled={disabled || paused} title={paused ? "New work is paused" : undefined}
        className="flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground hover:bg-sidebar-accent disabled:opacity-50 max-md:min-h-11">
        <Plus aria-hidden className="size-4 text-muted-foreground"/>New thread
      </button>}
    </header>
    <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
      {home ? <ul className="flex flex-col">
        {data.projects.map(project => <li key={project.id}>
          <button type="button" onClick={() => navigate({ project: project.id, level: "project" })}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent max-md:py-2.5">
            <span className="min-w-0 flex-1 break-all">{project.id}</span>
            {(project.waiting || 0) > 0 && <span className="shrink-0 text-xs font-medium text-primary">{project.waiting} waiting</span>}
            {project.paused && <span className="shrink-0 text-xs text-muted-foreground">paused</span>}
          </button>
        </li>)}
      </ul> : <>
        {GROUPS.map(([id, label]) => <Group key={id} id={id} label={label} rows={groups[id].length}>
          {groups[id].map(row => <ThreadItem key={row.id} row={row} all={all} selected={selected} now={now} navigate={navigate} project={current}/>)}
        </Group>)}
        <Group id="sessions" label={threads.length ? "Sessions outside threads" : "Sessions"} rows={live.length}>{live.map(sessionRow)}</Group>
        <Group id="inactive" label="Inactive sessions" rows={idle.length}>{idle.map(sessionRow)}</Group>
        {threads.length + loose.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">No threads yet. Start one with New thread.</p>}
      </>}
    </nav>
    <footer className="flex items-center gap-1 px-2 py-1.5 shadow-[0_-1px_0_var(--sidebar-border)]">
      <AppMenu {...props} current={current}/>
      <span className="flex-1"/>
      {controls}
    </footer>
  </div>;
}
