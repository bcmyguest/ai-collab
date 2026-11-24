"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { HarnessLogo, hasLogo } from "./logos";
import { Activity, Square, ArrowLeft, ArrowUp, AtSign, Bot, Check, CheckCheck, CircleCheck, Coffee, CornerLeftUp, FolderGit2, LoaderCircle, Menu, Minimize2, Monitor, Moon, Plus, Reply, RotateCw, Sun, VolumeX, X, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatContainerContent, ChatContainerRoot, ChatContainerScrollAnchor } from "@/components/ui/chat-container";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import { PromptInput, PromptInputAction, PromptInputActions, PromptInputTextarea } from "@/components/ui/prompt-input";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fuzzyRank } from "@/lib/fuzzy";
import { commandFor, matchCommands } from "@/lib/slash-commands";
import { contextMeter, filesRead } from "@/lib/context-view";
import { agentDetail } from "@/lib/agent-detail";
import { composerDestination } from "@/lib/message-routing";
import { quotedReply, usableReplyId } from "@/lib/reply-quote";
import { withMentions } from "@/lib/mentions";
import { chatThread } from "@/lib/chat-turns";
import { NewAgentComposer } from "./new-session";
import { PatternsPage } from "./patterns-page";
import { LandReviews } from "./land-reviews";
import { OutcomeRequest } from "./outcomes";
import { TaskBoard } from "./tasks";
import { Shipped } from "./shipped";
import { liveRows, projectThread, sessionTurns, withoutAnswered } from "@/lib/project-feed";
import { TABS, parseSelection, projectNavigation, selectionHash } from "@/lib/selection";
import { agentName, namedAgents, unnamedAgents } from "@/lib/sidebar";
import { sessionState } from "@/lib/session-state";
import { subscribeUiEvents } from "@/lib/ui-events";
import { ActivityRow, GoToAgent, Working } from "./activity";
import { ApprovalCard, QuestionCard } from "./cards";
import { SurfaceContext } from "@/components/a2ui/surface";
import { NotifyToggle } from "./notify";
import { DecisionQueue } from "./decisions";
import { InactiveSessions, SessionList, SessionMenu, StateChip, SubagentList } from "./home";
import { RunningCount, SubagentRuns } from "./subagent-runs";
import { ClosedProjects, ProjectMenu } from "./project-menu";
import { Quote } from "./quote";
import { ScheduledJobs } from "./scheduled";
import { quoteText } from "@/lib/quote";
import { CompactionMap } from "./compactions";
import { activityRows, groupSubagents } from "@/lib/activity-rows";
import { conversationKey, drafts, views } from "@/lib/view-memory";
import { streamViews } from "@/lib/stream-views";
import { toast } from "sonner";

const initial = { projects: [], harnesses: [], agents: [], messages: [] };
const PULL_THRESHOLD_PX = 70;
const PULL_MAX_PX = 110;
const HARNESS_COLORS = {
  claude: "[&_[data-slot=avatar-fallback]]:bg-claude", codex: "[&_[data-slot=avatar-fallback]]:bg-codex",
  cursor: "[&_[data-slot=avatar-fallback]]:bg-cursor", opencode: "[&_[data-slot=avatar-fallback]]:bg-opencode", operator: "[&_[data-slot=avatar-fallback]]:bg-primary",
  system: "[&_[data-slot=avatar-fallback]]:bg-muted-foreground",
};
const CONNECTION_TOAST = "connection";
const UPDATE_TOAST = "update";
const BUILD = process.env.AI_COLLAB_BUILD;
const QUIET_RETRY_MS = 500;
const RECONNECT_GRACE_MS = 3_000;
const STALE_AFTER_MS = 20_000;
const TICK_MS = 1000;
const AFK_MODES = [["off", "Off", Monitor], ["on", "On", Coffee], ["quiet", "Quiet", VolumeX]];
const HARNESS_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
const RECEIPTS = { sent: ["Sent", Check], delivered: ["Read by some sessions", CheckCheck], read: ["Read", CheckCheck] };
const clock = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
// Fired on a 401 or a closed stream; the sign-in gate asks /api/auth/me again.
const AUTH_CHECK = "ai-collab:auth-check";

function selection() {
  return parseSelection(location.hash.slice(1));
}

/** The /api/events query for a selection, and which view it shows. */
function streamOf(selected) {
  const stream = new URLSearchParams();
  const home = selected.level === "home" || selected.level === "inbox";
  const session = selected.level === "session" && Boolean(selected.session);
  if (selected.project && !home) stream.set("project", selected.project);
  if (session) stream.set("session", selected.session);
  // The project chat reads activity for its completion and live rows; a session's timeline, raw view and subagents read it too.
  const watching = selected.level === "project";
  const subagents = session && selected.tab === "subagents";
  const inline = session && selected.tab === "activity";
  const raw = session && selected.tab === "raw";
  // Sessions with none picked lists the project's sessions under the selector.
  const listing = selected.level === "session" && !selected.session;
  // The task board: its own sidebar level, read from the same project stream as the chat.
  const tasks = selected.level === "tasks";
  // The compaction map reads each agent's compactions and context from the sessions view.
  const compactions = selected.level === "compactions";
  if (watching || inline || subagents || raw) stream.set("view", "activity");
  else if (home) stream.set("view", "home");
  else if (listing || compactions) stream.set("view", "sessions");
  if (compactions) stream.set("history", "1");
  return { home, watching, subagents, inline, raw, listing, tasks, compactions, requested: stream.toString() };
}

async function api(path, payload) {
  const response = await fetch("/api/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_CHECK));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function ConversationHistory({ requested }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(search, extra = {}) {
    setBusy(true);
    setError("");
    try {
      const page = await api("history?" + requested, { query: search, ...extra });
      setResult(current => ({
        ...page, query: search,
        messages: extra.before ? [...current.messages, ...page.messages] : page.messages,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <details className="text-sm" onToggle={event => {
    if (event.currentTarget.open && !busy) void load(query);
  }}>
    <summary className="cursor-pointer">History{result?.unread ? " · " + result.unread + " unread" : ""}</summary>
    <div className="mt-2 max-h-[45vh] space-y-2 overflow-auto rounded-lg border p-2">
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void load(query); }}>
        <input aria-label="Search conversation history" placeholder="Search history" maxLength={200} value={query}
          onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-2"/>
        <Button size="sm" disabled={busy}>Search</Button>
        {!!result?.unread && !result.query && <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => load("", { read: result.latest })}>Mark as read</Button>}
      </form>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading history…</p>}
      {result && !result.messages.length && <p>No matching messages.</p>}
      {result?.messages.map(message => <div key={message.id} className="border-t pt-2">
        <div className="text-xs text-muted-foreground">{message.by || message.sender || message.from} · {new Date(message.time * 1000).toLocaleString()}</div>
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        {message.attachment && <a className="underline" href={"/api/file/" + encodeURIComponent(message.attachment.file)}>{message.attachment.name}</a>}
      </div>)}
      {result?.next && <Button size="sm" variant="outline" disabled={busy}
        onClick={() => load(result.query, { before: result.next })}>Load older</Button>}
    </div>
  </details>;
}

/** "msg 3m ago · active just now"; activity comes from the agent's hooks. */
function seen(item, now) {
  return item.activeAt ? `msg ${ago(item.lastMessageAt, now)} · active ${ago(item.activeAt, now)}` : `msg ${ago(item.lastMessageAt, now)}`;
}

/** After a deploy the server runs a newer build than this page; offer a reload until the operator takes it. */
async function checkBuild() {
  try {
    const response = await fetch("/api/version", { cache: "no-store" });
    const { build } = await response.json();
    if (!build || build === BUILD) return toast.dismiss(UPDATE_TOAST);
    toast.info("Update available", {
      id: UPDATE_TOAST, duration: Infinity, description: "A new version of AI Collab is deployed.",
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
  } catch {}
}

export function ago(ms, now) {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 15) return "just now";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + "m ago";
  if (seconds < 86400) return Math.round(seconds / 3600) + "h ago";
  return Math.round(seconds / 86400) + "d ago";
}

const peerOf = address => String(address || "").split("#")[0];
const short = address => address?.includes("#") ? address.slice(0, address.indexOf("#") + 9) : address;
const colorOf = address => HARNESS_COLORS[peerOf(address)] || "[&_[data-slot=avatar-fallback]]:bg-agent";

export function Avatar({ address, className, by }) {
  const peer = peerOf(address);
  const label = by ? by.slice(0, 2).toUpperCase() : peer === "operator" ? "You" : peer === "system" ? "Sys" : peer.slice(0, 2).toUpperCase();
  const fallback = !by && hasLogo(peer) ? <HarnessLogo peer={peer} className="size-[55%]"/> : label;
  return <MessageAvatar fallback={fallback} className={cn("size-8 text-[11px] font-semibold [&_[data-slot=avatar-fallback]]:text-white", colorOf(address), className)}/>;
}

function Dot({ online }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground/40")}/>;
}

// Operator away mode, broadcast to every project's agents.
function AfkToggle({ mode, disabled, set }) {
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

function ThemeToggle() {
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

// The session's human name after its address, when the harness or its first prompt gives one.
function SessionName({ agent }) {
  return agent?.name ? <span className="block min-w-0 truncate text-xs text-foreground/80" title={agent.name}>{agent.name}</span> : null;
}

// One session row in the sidebar: its name, address, running count, waiting dot and last activity.
// An agent row leads with its set_identity name; a plain row leads with its address.
function SessionRow({ agent, project, selected, now, navigate, dispose, openRaw, disabled, lead = "address" }) {
  // An agent row leads with the set_identity name, which a later harness title does not replace.
  const name = lead === "name" ? agent.identityName || agent.name : "";
  const label = name || short(agent.id);
  return <li className="flex min-w-0 flex-col gap-1">
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" aria-label={agent.waiting ? agent.id + ", waiting on you" : agent.id} title={agent.parent ? agent.id + " · started by " + agent.parent : agent.id} aria-current={selected.level === "session" && selected.session === agent.id ? "page" : undefined}
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
          <span className="self-start"><RunningCount runs={agent.subagents} now={now}/></span>
        </span>
        {agent.waiting && <span role="img" aria-label="Waiting on you" title="Waiting on you" className="inline-block size-2.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/25"/>}
        <Dot online={agent.online}/>
        <span className="shrink-0 text-right text-[11px] leading-tight text-muted-foreground">{ago(agent.lastMessageAt, now)}{agent.activeAt ? <><br/>active {ago(agent.activeAt, now)}</> : null}</span>
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

function Sidebar({ projectNav, data, selected, now, navigate, newSession, dispose, openRaw, disabled, projectAction, openHash, inactiveOpen, onInactiveToggle }) {
  const current = selected.project || data.project;
  // Home's state carries the server's default project's agents; they are not "this project" here.
  const home = selected.level === "home" || selected.level === "inbox";
  const visible = home ? [] : data.agents.filter(agent => !agent.gone);
  const active = [];
  const inactive = [];
  for (const agent of visible) {
    const group = sessionState(agent, now) === "offline" ? inactive : active;
    group.push(agent);
  }
  return <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4">
    <button type="button" onClick={() => navigate({ level: "home" })} aria-current={selected.level === "home" ? "page" : undefined}
      className="flex items-center gap-2 rounded-xl px-2 text-left text-sm font-semibold tracking-tight" title="Home: every project's sessions">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">ai</span>AI Collab
    </button>
    <Button variant="ghost" className="justify-start" onClick={() => navigate({ level: "inbox" })} aria-current={selected.level === "inbox" ? "page" : undefined}>Decision inbox</Button>
    <section>
      <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Projects</h2>
      <ul className="flex flex-col gap-1">
        {data.projects.map(project => <li key={project.id} className="flex items-center gap-1">
          <button type="button" aria-current={project.id === current ? "page" : undefined}
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
    {projectNav}
    {/* Scheduled jobs are the runner's own entries, not agents: they stay in their own section below. */}
    <ScheduledJobs project={home ? "" : current} openRun={openHash}/>
    {/* Agents (sessions that set an identity name) sit apart from the plain session rows and from Scheduled jobs. */}
    {!home && namedAgents(active).length > 0 && <AgentList agents={namedAgents(active)} project={current} selected={selected} now={now} navigate={navigate} dispose={dispose} openRaw={openRaw} disabled={disabled}/>}
    <section>
      <div className="flex items-center justify-between px-2 pb-2">
        <h2 className="min-w-0 truncate text-xs font-medium uppercase tracking-wider text-muted-foreground" title={home ? undefined : current}>{home ? "Sessions" : "Sessions · " + current}</h2>
        <button type="button" onClick={() => navigate(home ? { level: "home" } : { project: current, level: "session" })}
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

function ZoomControls({ data, selected, now, navigate, compact }) {
  const project = selected.project || data.project;
  return <div className="flex flex-wrap items-center gap-2">
    {/* Projects and sessions live in the sidebar (the menu on a phone); the header keeps only the session views. */}
    {selected.level === "session" && selected.session && (selected.tab === "raw"
      ? <Button variant="outline" size="sm" className="h-9 rounded-full" onClick={() => navigate({ ...selected, project, tab: "activity", run: "" })}><ArrowLeft/>Timeline</Button>
      : <Tabs value={selected.tab} onValueChange={tab => navigate({ ...selected, project, tab, run: "" })}>
        <TabsList aria-label="Session view" className="h-9">
          <TabsTrigger value="activity" className="px-3"><Activity/>Timeline</TabsTrigger>
          <TabsTrigger value="subagents" className="px-3"><Bot/>Subagents</TabsTrigger>
        </TabsList>
      </Tabs>)}
    {compact}
  </div>;
}

// WhatsApp-style ticks on the operator's own messages: ✓ sent, ✓✓ read by some (broadcast), primary ✓✓ read.
function Ticks({ state }) {
  const [label, Icon] = RECEIPTS[state] || [];
  if (!Icon) return null;
  return <span role="img" aria-label={label} title={label} data-receipt={state}
    className={cn("inline-flex", state === "read" ? "text-primary" : "text-muted-foreground")}><Icon className="size-3.5"/></span>;
}

function QueueRow({ message, disabled, change }) {
  const [draft, setDraft] = useState(null);
  return <li className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-sm">
    {draft === null ? <>
      <p className="min-w-0 flex-1 truncate" title={message.body}>{message.body}</p>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setDraft(message.body)}>Edit</Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => change(message, "cancel")}>Cancel</Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => change(message, "steer")}>Retry delivery</Button>
    </> : <form className="flex w-full flex-wrap items-center gap-2" onSubmit={async event => {
      event.preventDefault();
      if (await change(message, "edit", draft)) setDraft(null);
    }}>
      <textarea aria-label="Edit queued message" className="w-full rounded border bg-background p-2" autoFocus value={draft} maxLength={4000} onChange={event => setDraft(event.target.value)}/>
      <Button type="submit" size="sm" disabled={disabled || !draft.trim()}>Save</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>Discard edit</Button>
    </form>}
  </li>;
}

function ChatMessage({ message, operator, me, now, reply, replyFrom, open, act, answer, skip, disabled, detail, taskLinks }) {
  const sender = message.from || message.sender || "ntfy";
  const outgoing = sender === operator;
  // A signed-in family member's message names them; the viewer's own stays "You".
  const other = message.by && message.by !== me ? message.by : "";
  const label = message.system ? "System" : ["Question", "Reply", "Approval"].includes(message.kind) ? message.kind + " · " + (message.by || short(sender)) : short(sender);
  const at = message.time ? message.time * 1000 : 0;
  // An agent's avatar and name open its session (or harness) view; the operator's own, system and ntfy posts stay plain.
  const openable = !outgoing && sender !== "ntfy" && sender !== "operator" && sender !== "system";
  const go = () => open(sender);
  // A reply to an agent prefills its address so the mention routes the reply to that session.
  const prefill = openable ? "@" + sender + " " : "";
  // The asking agent's avatar and name, the header row of an A2UI card.
  const cardHead = <><Avatar address={sender} by={other} className="size-6 text-[10px]"/><span className="truncate">{short(sender)}</span></>;
  return <Message data-message-id={message.id} className={cn("max-w-full", outgoing && "flex-row-reverse")}
    onClick={event => { const tag = event.target.closest?.("[data-mention]"); if (tag) open(tag.textContent.replace(/^@/, "").split(/[:/]/)[0]); }}>
    {openable ? <button type="button" aria-label={"Open avatar " + sender} tabIndex={-1} className="shrink-0 self-start rounded-full" onClick={go}><Avatar address={sender}/></button> : <Avatar address={sender} by={other}/>}
    <div className={cn("flex min-w-0 max-w-[82%] flex-col gap-1", outgoing ? "items-end" : "items-start")}>
      <div className="flex max-w-full flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {openable ? <button type="button" aria-label={"Open " + sender} title={sender} onClick={go}
          className="font-medium text-foreground underline-offset-2 hover:underline">{label}</button>
          : <span className="font-medium text-foreground" title={message.by ? sender + " · " + message.by : sender}>{outgoing ? other || "You" : label}</span>}
        {detail && <span data-agent-detail className="text-[11px] text-muted-foreground/80">{"· " + detail}</span>}
        {message.to && message.to !== "all" && <span title={message.to}>→ {short(message.to)}</span>}
        {message.terminal && <Badge variant="outline" data-terminal title="Typed in the agent's terminal" className="h-4 px-1.5 text-[10px]">terminal</Badge>}
        {message.replyTo && <Badge variant="outline" data-answer title={"Answers question " + message.replyTo} className="h-4 px-1.5 text-[10px]">answer</Badge>}
        {at > 0 && <time dateTime={new Date(at).toISOString()} title={clock.format(at)}>{ago(at, now)}</time>}
        {replyFrom && message.kind !== "Approval" && <button type="button" aria-label={"Reply to " + sender} title="Reply" onClick={() => replyFrom({ id: message.id, sender, prefill, body: message.body })}
          className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"><Reply className="size-3.5"/></button>}
        {message.scope === "all" && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">to all</Badge>}        {message.urgent && !message.cancelled && <span role="img" aria-label="Sent now" title="Sent now: delivered at the agent's next tool call" data-urgent className="text-amber-500"><Zap className="size-3.5"/></span>}
        {outgoing && (message.queueStatus ? <span>{message.queueStatus}</span> : <Ticks state={message.receipt}/>)}
        {openable && sender.includes("#") && <GoToAgent onClick={go} className="size-6"/>}
      </div>
      {message.quote && <Quote quote={message.quote} label={short(message.quote.sender)}/>}
      {message.kind === "Approval" ? <ApprovalCard approval={message.approval} now={now} disabled={disabled} act={act} skip={skip} head={cardHead}/>
        : message.kind === "Question" && message.question ? <QuestionCard question={message.question} body={withMentions(message.body)} taskLinks={taskLinks} answer={message.answer} by={message.answeredBy} skipped={message.skipped} disabled={disabled} onAnswer={body => answer(message.question, body)} skip={skip} head={cardHead}/>
        : <MessageContent markdown taskLinks={taskLinks} className={cn("bubble max-w-full rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed shadow-xs [overflow-wrap:anywhere]",
        outgoing ? "rounded-tr-md border border-primary/25 bg-primary/10 text-foreground" : "rounded-tl-md border bg-card text-card-foreground",
        message.kind === "Question" && "border-amber-500/50")}>{withMentions(message.body)}</MessageContent>}
      {message.attachment && <a href={"/api/file/" + encodeURIComponent(message.attachment.file)} target="_blank" rel="noreferrer" className="block max-w-full overflow-hidden rounded-2xl border bg-card">
        <img src={"/api/file/" + encodeURIComponent(message.attachment.file)} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }}
          className="max-h-96 w-auto max-w-full object-contain"/>
        <span className="block break-all px-3 py-1.5 text-sm underline">{message.attachment.name}</span>
      </a>}
      {message.kind === "Question" && message.question && !message.answer && <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={() => reply(message.question)}>Reply from the composer</Button>}
    </div>
  </Message>;
}

// Starts a headless agent session in the current project's registered folder; the result stays until closed.
// Model lists per harness from the models action; an empty object when it fails.
function useModels(project) {
  const [models, setModels] = useState({});
  useEffect(() => {
    let live = true;
    fetch("/api/models", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }) })
      .then(response => response.ok ? response.json() : {}).catch(() => ({}))
      .then(list => { if (live && list && typeof list === "object" && !Array.isArray(list)) setModels(list); });
    return () => { live = false; };
  }, [project]);
  return models;
}

const modelsOf = (models, harness) => Array.isArray(models[harness]) ? models[harness].filter(id => typeof id === "string" && id) : [];

function Composer({ conversation, agents, harnesses, teams = [], startable = [], models = {}, now, disabled, placeholder, routing, onSend, question, cancel, urgentable, replying, cancelReply, harness = "", initialDraft = "" }) {
  const [draft, setDraftState] = useState(() => drafts.get(conversation, "") || initialDraft);
  const [urgent, setUrgent] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [held, setHeld] = useState(null);
  // Command names the picker inserted in this draft; only these and known commands make the message a command.
  const picked = useRef(new Set());
  const pending = useRef(false);
  const prefillFocused = useRef(false);
  const mention = mentionAt(draft);
  const options = [...agents.map(agent => ({ id: agent.id, name: agent.name, lastMessageAt: agent.lastMessageAt, activeAt: agent.activeAt, online: agent.online })),
    ...harnesses.map(harness => ({ id: harness.id, lastMessageAt: harness.lastMessageAt, activeAt: harness.activeAt, harness: true })),
    ...(teams || []).map(team => ({ id: team.id, team: true, members: team.members })),
    ...startable.flatMap(harness => modelsOf(models, harness).map(model => ({ id: harness + ":" + model, harness, model }))),
    // Open subagent runs of the project's sessions, tagged @session/run.
    ...agents.flatMap(agent => (agent.subagents || []).filter(run => run.open).map(run => ({ id: agent.id + "/" + run.run, owner: agent.id, run: true,
      label: short(agent.id) + " › " + [run.kind || "agent", run.description].filter(Boolean).join(": ") })))];
  // "@codex g5" narrows to codex's models; "@gpt" ranks every option.
  const matches = fuzzyRank(mention ? mention[1] + (mention[2] ?? "") : "", mention?.[2] !== undefined ? options.filter(option => option.model && option.harness === mention[1]) : options,
    option => [option.id, option.name, option.label, HARNESS_NAMES[option.harness === true ? option.id : option.harness], option.model, ...(option.team ? option.members || [] : [])]);
  const picking = showPicker && matches.length > 0;
  const chosen = Math.min(activeIndex, matches.length - 1);
  // "/comp" while typing a command for the selected session: its names with support from web/lib/slash-commands.js.
  const typedCommand = harness && /^\/[a-z0-9-]*$/i.test(draft) ? draft.slice(1) : null;
  const commands = typedCommand === null ? [] : matchCommands(harness, typedCommand);
  const commandPicking = commands.length > 0 && !picking && commandsOpen;
  const commandChosen = Math.min(activeIndex, commands.length - 1);
  const busy = disabled || posting;
  const text = draft.trim();
  const quoted = Boolean(replying?.id && !usableReplyId(replying.id));
  const command = routing.session && commandFor(text, picked.current) !== null;
  const destination = question ? "Reply to question " + question
    : command ? "Command for " + short(routing.target)
    : composerDestination({ ...routing, agents, teams, startable, models, quoted,
      text: quoted ? quotedReply(text, replying) : text });
  const sendName = question || command ? destination
    : "Send · " + destination;

  // Every edit is kept per conversation, so a tab or view switch that remounts the composer restores it.
  function setDraft(next) { setHeld(null); drafts.set(conversation, next); setDraftState(next); }
  function focus() { document.getElementById("composer")?.focus(); }
  useEffect(() => {
    if (!initialDraft || disabled || prefillFocused.current) return;
    const input = document.getElementById("composer");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    prefillFocused.current = true;
  }, [initialDraft, disabled]);
  // A Reply click prefills the agent's @tag ahead of whatever the operator has typed.
  useEffect(() => {
    if (!replying) return;
    if (replying.prefill && !draft.startsWith(replying.prefill)) setDraft(replying.prefill + draft);
    focus();
  }, [replying]);
  // The @tag being typed: [tag text, first word, second word when the first names a startable harness].
  function mentionAt(text) {
    const found = /(?:^|\s)@([\w#:./-]*)(?: ([\w.:/-]+))?$/.exec(text);
    return found && (found[2] === undefined || startable.includes(found[1])) ? [found[0].replace(/^\s/, ""), found[1], found[2]] : null;
  }
  function change(next) { setDraft(next); setShowPicker(mentionAt(next) !== null); setCommandsOpen(true); setActiveIndex(0); }
  function insert(option) {
    const prefix = mention ? draft.slice(0, -mention[0].length) : draft + (draft && !/\s$/.test(draft) ? " " : "");
    setDraft(prefix + "@" + option.id + " ");
    setShowPicker(false);
    focus();
  }
  function insertCommand(command) {
    picked.current.add(command.name);
    setDraft("/" + command.name + (command.args ? " " : ""));
    setActiveIndex(0);
    focus();
  }
  async function send(sendAnyway = false, sendNow = urgent) {
    if (pending.current || busy || !draft.trim()) return;
    pending.current = true;
    setPosting(true);
    const text = draft.trim();
    try {
      // onSend returns true only when the message was sent (or a command ran or was requested); otherwise the draft stays.
      const result = await onSend(text, urgentable && sendNow, commandFor(text, picked.current) !== null, sendAnyway);
      if (result === "draftHeld") setHeld({ text, replying, question, sendNow });
      if (result === true) {
        setDraft(""); setShowPicker(false); setUrgent(false); picked.current.clear();
      }
    }
    finally { pending.current = false; setPosting(false); focus(); }
  }
  return <div className="relative mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
    {held?.text === draft.trim() && held.replying === replying && held.question === question && <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm">
      <span role="status">The terminal has an unsent draft.</span>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => send(true, held.sendNow)}>Send anyway</Button>
    </div>}
    {question && <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">Replying to question {question}</span>
      <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
    </div>}
    {replying && !question && <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border bg-muted px-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">Replying to {short(replying.sender)}{replying.body && <span className="text-muted-foreground"> · {quoteText(replying.body)}</span>}</span>
      <Button variant="ghost" size="icon" className="size-6" aria-label="Cancel reply" onClick={cancelReply}><X/></Button>
    </div>}
    {commandPicking && <div role="listbox" aria-label="Session commands"
      className="absolute inset-x-3 bottom-full mb-1 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {commands.map((command, i) => <button type="button" role="option" aria-selected={i === commandChosen} aria-disabled={command.status === "unsupported"} key={command.name}
        title={command.reason} onMouseDown={event => event.preventDefault()} onClick={() => command.status !== "unsupported" && insertCommand(command)}
        className={cn("flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm", i === commandChosen && "bg-accent text-accent-foreground", command.status === "unsupported" && "opacity-50")}>
        <span className="flex min-w-0 flex-1 flex-col"><span className="font-mono text-xs">/{command.name}{command.args ? " " + command.args : ""}</span>
          <span className="truncate text-xs text-foreground/80">{command.summary}</span></span>
        {command.status === "partial" && <span className="shrink-0 rounded-full border px-1.5 text-[10px] text-amber-600">partial</span>}
        {command.status === "unverified" && <span className="shrink-0 rounded-full border px-1.5 text-[10px] text-amber-600">unverified</span>}
        {command.status === "unsupported" && <span className="shrink-0 text-xs text-muted-foreground">unsupported</span>}
      </button>)}
    </div>}
    {picking && <div role="listbox" aria-label="Mention an agent"
      className="absolute inset-x-3 bottom-full mb-1 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {matches.map((option, i) => <button type="button" role="option" aria-selected={i === chosen} key={option.id}
        onMouseDown={event => event.preventDefault()} onClick={() => insert(option)}
        className={cn("flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm", i === chosen && "bg-accent text-accent-foreground")}>
        <Avatar address={option.run ? option.owner : option.model ? option.harness : option.team ? "operator" : option.id} className="size-6 text-[9px]"/>
        <span className="flex min-w-0 flex-1 flex-col">{option.run ? <span className="truncate text-xs text-foreground/80">{option.label}</span> : <span className="truncate font-mono text-xs">@{option.id}</span>}
          {option.run ? null : option.model ? <span className="truncate text-xs text-foreground/80">{(HARNESS_NAMES[option.harness] || option.harness) + " · " + option.model}</span> : option.team ? <span className="truncate text-xs text-foreground/80">{(option.members || []).join(", ")}</span> : <SessionName agent={option}/>}</span>
        {!option.harness && !option.run && !option.team && <Dot online={option.online}/>}
        <span className="shrink-0 text-xs text-muted-foreground">{option.run ? "subagent" : option.team ? "team" : option.model ? "new session" : (option.harness ? "harness · " : "") + seen(option, now)}</span>
      </button>)}
    </div>}
    <div onKeyDownCapture={event => {
      if (commandPicking) {
        if (event.key === "Escape") setCommandsOpen(false);
        else if (event.key === "ArrowDown") setActiveIndex((commandChosen + 1) % commands.length);
        else if (event.key === "ArrowUp") setActiveIndex((commandChosen + commands.length - 1) % commands.length);
        else if (event.key === "Tab" && commands[commandChosen].status !== "unsupported") insertCommand(commands[commandChosen]);
        else return;
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (!picking) return;
      if (event.key === "Escape") setShowPicker(false);
      else if (event.key === "ArrowDown") setActiveIndex((chosen + 1) % matches.length);
      else if (event.key === "ArrowUp") setActiveIndex((chosen + matches.length - 1) % matches.length);
      // In "@codex fix…" the second word may be prose: Enter sends, Tab or a click picks a model.
      else if ((event.key === "Enter" && !event.shiftKey && mention?.[2] === undefined) || event.key === "Tab") insert(matches[chosen]);
      else return;
      event.preventDefault(); event.stopPropagation();
    }}>
      <PromptInput value={draft} onValueChange={change} onSubmit={() => send()} disabled={busy} className="rounded-3xl bg-card shadow-sm">
        <div id="composer-destination" aria-live="polite" className="max-h-[20dvh] overflow-y-auto break-words px-3 pt-1 text-xs font-medium text-muted-foreground">
          {destination}
        </div>
        <PromptInputTextarea id="composer" aria-label="Message" aria-describedby="composer-destination" placeholder={placeholder} className="text-[15px]"/>
        <PromptInputActions className="justify-between px-1 pt-1">
          <PromptInputAction tooltip="Mention an agent">
            <Button type="button" variant="ghost" size="sm" className="rounded-full" aria-expanded={picking} disabled={busy}
              onClick={() => { setShowPicker(!showPicker); setActiveIndex(0); focus(); }}><AtSign/>Mention</Button>
          </PromptInputAction>
          <div className="flex items-center gap-1">
            {urgentable && !command && <PromptInputAction tooltip="Deliver at the agent's next tool call instead of its next turn">
              <Button type="button" variant={urgent ? "secondary" : "ghost"} size="sm" className={cn("rounded-full", urgent && "text-amber-500")} aria-pressed={routing.session ? undefined : urgent} disabled={busy || (routing.session && !text)}
                onClick={() => routing.session ? send(false, true) : setUrgent(!urgent)}><Zap/>Send now</Button>
            </PromptInputAction>}
            <PromptInputAction tooltip={sendName}>
              <Button type="button" size="icon" className="rounded-full" aria-label={sendName} disabled={busy || !draft.trim()} onClick={() => send()}><ArrowUp/></Button>
            </PromptInputAction>
          </div>
        </PromptInputActions>
      </PromptInput>
    </div>
  </div>;
}

// The session's context: tokens used (with the window and a warning when the harness reported one) and its files.
function ContextChip({ context, rows }) {
  const meter = contextMeter(context);
  const loaded = context.files || [];
  const read = filesRead(rows);
  const tone = meter.level === "full" ? "border-destructive text-destructive" : meter.level === "warn" ? "border-amber-500 text-amber-600" : "text-muted-foreground";
  const warning = meter.level === "full" ? " · full" : meter.level === "warn" ? " · near full" : "";
  const [open, setOpen] = useState(false);
  // A sheet fits any phone width; a popover anchored to the chip ran off the left edge at 390px.
  return <>
    <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
      className={cn("flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs", tone)}>
      Context{meter.text && " " + meter.text}{warning}</button>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto break-words p-0">
        <div className="flex flex-col gap-3 px-4 pb-6 pt-4 text-xs">
          <SheetTitle className="text-base">Context</SheetTitle>
          <SheetDescription className="text-xs">{meter.text ? "Tokens in context: " + meter.text : "No usage reported yet."}</SheetDescription>
          <p className="font-medium">Files in context</p>
          {loaded.length ? <ul className="flex flex-col gap-1.5">{loaded.map(entry => <li key={entry.path} className="min-w-0 break-all font-mono" title={entry.path}>{entry.path}
            <span className="block text-muted-foreground">{entry.memory} · {entry.load.replace(/_/g, " ")}</span></li>)}</ul>
            : <p className="text-muted-foreground">None recorded. Claude reports them through its InstructionsLoaded hook.</p>}
          {/* Shown only once activity rows have loaded; before that, no reads are known, so the section stays out. */}
          {rows.length > 0 && <>
            <p className="font-medium">Files read</p>
            {read.length ? <ul className="flex flex-col gap-1.5">{read.map(entry => <li key={entry.path} className="min-w-0 break-all font-mono" title={entry.path}>{entry.path}
              <span className="text-muted-foreground"> · {entry.count}×</span></li>)}</ul>
              : <p className="text-muted-foreground">No file reads in the loaded activity.</p>}
          </>}
        </div>
      </SheetContent>
    </Sheet>
  </>;
}

// A session's finished turn(s) in the project chat: the first line of the final reply; tap opens the session.
function CompletionRow({ row, when, open }) {
  return <button type="button" data-type="completion" onClick={() => open(row.agent)} title={row.agent}
    className="flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent">
    <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"/>
    <span className="min-w-0 flex-1 truncate"><span className="font-mono text-foreground">{short(row.agent)}</span> finished{row.turns > 1 ? " " + row.turns + " turns" : ""}{row.text && " · " + row.text}</span>
    {row.time > 0 && <time className="shrink-0 text-xs" dateTime={new Date(row.time * 1000).toISOString()}>{when(row.time * 1000)}</time>}
  </button>;
}

// A busy session in the project chat: its current turn's summary; tap opens the session.
function LiveRow({ row, open }) {
  return <button type="button" data-type="live" onClick={() => open(row.agent)} title={row.agent}
    className="flex min-w-0 items-center gap-2 rounded-xl border border-dashed bg-card px-2.5 py-1.5 text-left text-sm">
    <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground"/>
    <span className="min-w-0 flex-1 truncate"><span className="font-mono">{short(row.agent)}</span> · working{row.summary && " on " + row.summary}</span>
  </button>;
}

// With GitHub sign-in on, a signed-out visitor sees only the sign-in button; a 401 or closed stream checks again.
export default function Chat() {
  const [account, setAccount] = useState(null);
  useEffect(() => {
    let live = true;
    const check = () => fetch("/api/auth/me", { cache: "no-store" }).then(response => response.json())
      .then(result => { if (live) setAccount(result); }, () => { if (live) setAccount(current => current || { enabled: false, user: null }); });
    check();
    window.addEventListener(AUTH_CHECK, check);
    return () => { live = false; window.removeEventListener(AUTH_CHECK, check); };
  }, []);
  if (!account) return null;
  if (account.enabled && !account.user) return <SignIn/>;
  return <Console account={account}/>;
}

function SignIn() {
  return <main className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
    <h1 className="text-xl font-semibold">AI Collab</h1>
    <p className="text-sm text-muted-foreground">Sign in to message your agents.</p>
    <Button asChild className="rounded-full"><a href="/api/auth/login">Sign in with GitHub</a></Button>
  </main>;
}

async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.dispatchEvent(new Event(AUTH_CHECK));
}

function Console({ account }) {
  const [selected, setSelected] = useState(selection);
  // A screen switched back to renders its cached view, and its stream then revalidates it.
  const [cached] = useState(() => streamViews.restore(streamOf(selected).requested));
  const [data, setData] = useState(cached?.data || initial);
  const [activity, setActivity] = useState(cached?.activity || []);
  // A2UI surfaces by id, from the stream's ACTIVITY_SNAPSHOT frames.
  const [surfaces, setSurfaces] = useState(cached?.surfaces || {});
  const [pull, setPull] = useState(0);
  const pullFrom = useRef(null);
  const pullRef = useRef(0);
  const [pullSide, setPullSide] = useState("top");
  const stick = useRef(null);
  // A restored view is already complete, so its screen renders at once instead of waiting for the new state frame.
  const [ready, setReady] = useState(Boolean(cached));
  const [outcomeProject, setOutcomeProject] = useState("");
  const [outcomeError, setOutcomeError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [question, setQuestion] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const [creating, setCreating] = useState("");
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const route = useRef("");
  const retrying = useRef(false);
  const shown = useRef(false);
  const autoRetry = useRef(true);
  const hiddenAt = useRef(0);
  const { home, watching, subagents, inline, raw, listing, tasks, compactions, requested } = streamOf(selected);
  route.current = requested;
  // Home and a Sessions list remember their scroll and Dead group; other views open at the newest message.
  const memoryKey = home ? (selected.level === "home" ? "home" : "") : listing ? "sessions " + (selected.project || data.project || "") : "";
  const [, remembered] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const list = stick.current?.scrollRef.current;
    if (home && list) {
      stick.current.stopScroll();
      list.scrollTop = 0;
      return;
    }
    const saved = memoryKey && views.get(memoryKey, {}).scrollTop;
    if (!list || !saved) { stick.current?.scrollToBottom("instant"); return; }
    // Leaving the bottom lock first stops use-stick-to-bottom pulling the restored list down on its next resize.
    stick.current.stopScroll();
    list.scrollTop = saved;
  }, [ready, requested, home]);
  useEffect(() => {
    const list = stick.current?.scrollRef.current;
    if (!ready || !memoryKey || !list) return;
    const save = () => views.set(memoryKey, { ...views.get(memoryKey, {}), scrollTop: list.scrollTop });
    list.addEventListener("scroll", save, { passive: true });
    return () => list.removeEventListener("scroll", save);
  }, [ready, requested, memoryKey]);
  const [seenDecisions, setSeenDecisions] = useState(() => new Set());
  const markDecisionSeen = key => setSeenDecisions(seen => new Set(seen).add(key));
  const [inactiveOpen, setInactiveOpen] = useState(false);
  useEffect(() => {
    try { setInactiveOpen(localStorage.getItem("ai-collab:show-inactive") === "true"); } catch {}
  }, []);
  function rememberInactive(open) {
    setInactiveOpen(open);
    try { localStorage.setItem("ai-collab:show-inactive", String(open)); } catch {}
  }
  function rememberDead(open) {
    if (Boolean(views.get(memoryKey, {}).dead) === open) return;
    views.set(memoryKey, { ...views.get(memoryKey, {}), dead: open });
    remembered(n => n + 1);
  }
  useEffect(() => {
    const change = () => {
      const next = selection();
      // A hash change that keeps the same stream (a tab or subagent run over rows already loaded) keeps its state.
      const nextStream = streamOf(next).requested;
      const same = nextStream === route.current;
      // Set now so the old stream's events, until its effect closes it, are dropped.
      route.current = nextStream;
      setSelected(next);
      if (same) return;
      // A screen still in the cache is shown at once; the reconnected stream revalidates it. An uncached one keeps the
      // old snapshot's project list beside it until its own state frame arrives, so the sidebar never empties.
      const view = streamViews.restore(nextStream);
      if (view) { setData(view.data); setActivity(view.activity); setSurfaces(view.surfaces); }
      else setActivity([]);
      setReady(Boolean(view)); setLoadError(""); setNotice(""); setQuestion(""); setReplyTo(null); setNavOpen(false);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    // Relative times only; no network.
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let controller;
    let subscription;
    let closed = false;
    let bannerTimer = 0;
    let retryTimer = 0;
    // Error banners wait for one quiet reconnect; a manual Retry or a visible error ends in one toast.
    const show = error => { clearTimeout(bannerTimer); shown.current = true; setLoadError(error); };
    // A failure that heals within RECONNECT_GRACE_MS (a phone waking up) shows nothing, so no "Reconnected" follows.
    const fail = error => {
      if (!retrying.current) { clearTimeout(bannerTimer); bannerTimer = setTimeout(() => show(error), RECONNECT_GRACE_MS); return; }
      show(error);
      retrying.current = false; toast.error("Reconnect failed", { id: CONNECTION_TOAST, description: error });
    };
    const reconnect = () => { autoRetry.current = true; setRevision(n => n + 1); };
    const disconnected = error => {
      if (controller.signal.aborted || requested !== route.current) return;
      controller.abort();
      if (error?.status) {
        closed = true;
        if (account.enabled) window.dispatchEvent(new Event(AUTH_CHECK));
        if (autoRetry.current && !retrying.current) { autoRetry.current = false; retryTimer = setTimeout(() => setRevision(n => n + 1), QUIET_RETRY_MS); return; }
        return fail("Connection closed");
      }
      if (retrying.current) fail("Server unreachable. Still retrying automatically.");
      else if (!bannerTimer) bannerTimer = setTimeout(() => show("Reconnecting…"), RECONNECT_GRACE_MS);
      retryTimer = setTimeout(open, RECONNECT_GRACE_MS);
    };
    function open() {
      controller = new AbortController();
      let checked = false;
      // Every frame of this stream also builds the cached view, so a switch back shows the newest one.
      const view = streamViews.connect(requested);
      subscription = subscribeUiEvents(() => fetch("/api/events?" + requested, {
        headers: { Accept: "text/event-stream" }, signal: controller.signal,
      }), {
        next({ event, data }) {
          if (requested !== route.current) return;
          if (event === "problem") {
            closed = true;
            controller.abort();
            subscription.unsubscribe();
            return fail(data.error);
          }
          const next = view(event, data);
          if (!next) return;
          if (event === "state") {
            if (!checked) { checked = true; checkBuild(); }
            clearTimeout(bannerTimer); bannerTimer = 0;
            setReady(true); setLoadError(""); setNow(Date.now());
            toast.dismiss(CONNECTION_TOAST);
            retrying.current = false; shown.current = false; autoRetry.current = true;
          }
          // The cached view is the one source for all three, so a reconnect keeps a surface that did not change.
          setData(next.data); setActivity(next.activity); setSurfaces(next.surfaces);
        },
        error: disconnected,
        complete: disconnected,
      });
    }
    open();
    // Phones suspend background pages and can leave a dead stream open; reconnect quietly on return.
    const resume = () => {
      if (document.visibilityState === "hidden") { hiddenAt.current = Date.now(); return; }
      const away = hiddenAt.current && Date.now() - hiddenAt.current > STALE_AFTER_MS;
      hiddenAt.current = 0;
      if (closed || away) reconnect();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", reconnect);
    return () => {
      clearTimeout(bannerTimer); clearTimeout(retryTimer); controller.abort(); subscription.unsubscribe();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", reconnect);
    };
  }, [requested, revision]);
  // Pull to refresh: a touch drag down from the top or up from the bottom past PULL_THRESHOLD_PX reconnects like Retry.
  // The scrolling element is StickToBottom.Content's outer div (overflow-y-auto via scrollClassName).
  function pullStart(event) {
    if (!event.currentTarget.firstElementChild) return;
    const list = event.currentTarget.firstElementChild;
    const typing = document.activeElement?.id === "composer";
    const selecting = Boolean(window.getSelection?.()?.toString());
    const top = atTop(list), bottom = atBottom(list);
    pullFrom.current = (top || bottom) && !typing && !selecting && event.touches.length === 1 ? { y: event.touches[0].clientY, top, bottom } : null;
  }
  function pullMove(event) {
    if (pullFrom.current === null) return;
    const list = event.currentTarget.firstElementChild;
    const dy = event.touches[0].clientY - pullFrom.current.y;
    const side = dy > 0 && pullFrom.current.top && atTop(list) ? "top" : dy < 0 && pullFrom.current.bottom && atBottom(list) ? "bottom" : null;
    if (!side) { pullFrom.current = null; pullTo(0); return; }
    setPullSide(side);
    pullTo(Math.abs(dy));
  }
  function pullEnd() {
    const ready = pullFrom.current !== null && pullRef.current >= PULL_THRESHOLD_PX;
    pullFrom.current = null;
    pullTo(0);
    if (ready) retry();
  }
  function atTop(list) { return list.scrollTop <= 0; }
  function atBottom(list) { return list.scrollHeight - list.scrollTop - list.clientHeight <= 1; }
  function pullTo(px) { pullRef.current = px; setPull(px); }
  function retry() {
    retrying.current = true;
    setRevision(n => n + 1);
  }

  function navigate(next) {
    setNavOpen(false);
    location.hash = selectionHash(next);
  }
  const project = selected.project || data.project || "";
  const models = useModels(project);
  const level = selected.level;
  const tasksView = level === "tasks";
  const composeTask = selected.composeTask || "";
  const taskLinks = useMemo(() => ({ project, ids: new Set(data.tasks?.tasks.map(task => task.id)) }), [project, data.tasks]);
  // The new-agent composer replaces the chat while it is open.
  const paused = data.projects.some(item => item.id === project && item.paused);
  const composing = level === "project" && Boolean(creating) && creating === project && ready && !paused;
  const projectLinks = projectNavigation(project, level);
  const agent = level === "session" ? data.agents.find(item => item.id === selected.session) : undefined;
  const target = level === "session" ? selected.session : "all";
  const missing = level === "session" && !target;
  const patterns = level === "patterns";
  const inbox = level === "inbox";
  const identity = agentName(agent);
  const sessionLabel = !agent?.generatedName ? agent?.name : "";
  const title = inbox ? "Decision inbox" : home ? "Home" : patterns ? "Patterns" : tasksView ? "Tasks" : level === "session" ? identity || sessionLabel || short(selected.session) || "Sessions" : project;
  // A home or Sessions card opens its session, or one of its subagent runs.
  const openCard = (node, run = "") => navigate({ project: node.project, level: "session", harness: node.harness || peerOf(node.id), session: node.id, ...(run ? { tab: "subagents", run } : {}) });
  // The session's ⋯ menu opens its raw activity: every tool call, unfolded.
  const openRaw = node => navigate({ project: node.project, level: "session", harness: node.harness || peerOf(node.id), session: node.id, tab: "raw" });
  const placeholder = composeTask ? `Message about #${composeTask}…` : "Write a message…";
  const routing = { project, target, session: level === "session" && Boolean(target), tasks: data.tasks?.tasks || [],
    peers: data.projects.find(item => item.id === project)?.peers || [],
    patterns: data.patterns || [], hosted: data.hosted };
  // A session command: resolves true only when the session ran it or the compaction was requested (the composer clears).
  async function runCommand(body) {
    const at = requested;
    setWorking(true);
    try {
      const result = await api("command", { project, target: selected.session, command: body });
      if (at === route.current) setNotice([result.status, result.detail].filter(Boolean).join(" · "));
      return result.status === "succeeded" || result.status === "requested";
    } catch (err) { if (at === route.current) setNotice(err.message); return false; }
    finally { setWorking(false); }
  }
  async function action(path, payload, fallback) {
    const at = requested;
    setWorking(true);
    try {
      const result = await api(path, { project, ...payload });
      if (result.draftHeld) return "draftHeld";
      if (at === route.current) {
        // A running session needs no wake note; its message's ticks tell the rest.
        const outcome = (result.wake && !["online", "queued"].includes(result.wake.status) && result.wake) || result.compact || (result.wake ? { status: result.status, detail: result.detail } : result);
        // A reply the server could not link says so, with the quote it sent instead.
        const note = result.quoted ? [outcome.status || "Sent", "as plain text quoting the original"].filter(Boolean).join(" · ") : [outcome.status, outcome.detail || outcome.message || outcome.reason].filter(Boolean).join(" · ");
        setNotice(note || fallback);
      }
      return true;
    } catch (err) { if (at === route.current) setNotice(err.message); return false; }
    finally { setWorking(false); }
  }
  // A tapped sender or @tag: a session address opens its thread, a bare harness name the session list.
  function openAddress(address) {
    const [peer, session] = String(address).split("#");
    if (!peer || peer === "all" || peer === "operator" || peer === "ntfy" || peer === "system") return;
    navigate(session ? { project, level: "session", harness: peer, session: address } : { project, level: "session" });
  }
  // The raw view keeps every tool call as its own row; the timeline and subagents fold them into turns and runs.
  // A run link's window (selected.window) cuts the timeline to the rows of that schedule run.
  const windowRows = useMemo(() => {
    const from = selected.window?.from;
    const to = selected.window?.to;
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) ? activity.filter(row => row.time * 1000 >= from && row.time * 1000 <= to) : activity;
  }, [activity, selected.window]);
  const rows = useMemo(() => watching || inline || subagents ? groupSubagents(activityRows(windowRows)) : raw ? activityRows(windowRows) : [], [watching, inline, subagents, raw, windowRows]);
  const goRun = row => navigate({ project, level: "session", harness: peerOf(row.agent), session: row.agent, tab: "subagents", run: row.run });
  // Answers whose card is listed show in the card, so their bubbles stay out of both threads.
  const queue = level === "session" && ready ? data.messages.filter(item => item.queued && item.to === target) : [];
  const visible = useMemo(() => withoutAnswered(level === "session" ? data.messages.filter(item => !item.queued) : data.messages), [data.messages, level]);
  // A run window keeps the chat messages that arrived during the same run, so they sit beside its rows.
  const scoped = useMemo(() => {
    const from = selected.window?.from;
    const to = selected.window?.to;
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) ? visible.filter(item => item.time * 1000 >= from && item.time * 1000 <= to) : visible;
  }, [visible, selected.window]);
  const turns = useMemo(() => sessionTurns(rows), [rows]);
  // The project chat shows finished turns and busy sessions, not every tool call.
  const live = useMemo(() => watching ? liveRows(turns, rows, now) : [], [turns, rows, watching, now]);
  const thread = useMemo(() => inline ? chatThread(scoped, rows, selected.session)
    : watching ? projectThread(visible, turns)
    : raw ? rows.map(activity => ({ activity }))
    : visible.map(message => ({ message })), [visible, scoped, turns, rows, inline, watching, raw, selected.session]);
  const newSession = id => { setCreating(id); if (id !== project || level !== "project") navigate({ project: id, level: "project" }); else setNavOpen(false); };
  async function startSession(payload) {
    try { return await api("start", { project, ...payload }); } catch (err) { return { status: "failed", detail: err.message }; }
  }
  // Pattern saves, copies, deletes and operator advances all post to the pattern action; a failure comes back as { error }.
  async function patternCall(payload) {
    try { return await api("pattern", payload); } catch (err) { return { error: err.message }; }
  }
  // Close, reopen and delete a project; Delete asks first and leaves the repo, worktrees and ntfy history alone.
  async function projectAction(path, name) {
    if (path === "request-outcome") {
      setNavOpen(false);
      setOutcomeError("");
      setOutcomeProject(name);
      return;
    }
    if (path === "delete" && !window.confirm("Delete " + name + " from the project registry? Its repo, worktrees and ntfy history stay. Live sessions in its repo will re-home under the folder name.")) return;
    const done = await action(path, { project: name }, path === "close" ? "Closed" : path === "reopen" ? "Reopened" : "Deleted");
    if (done && path !== "reopen" && name === (selected.project || data.project)) navigate({ level: "home" });
  }
  const sidebarProps = {
    inactiveOpen, onInactiveToggle: rememberInactive, data, selected, now, navigate, newSession, disabled: working,
    dispose: node => action("dispose", { project: node.project, target: node.id }, "Disposed"), openRaw, projectAction,
    openHash: hash => { setNavOpen(false); location.hash = hash.slice(1); },
  };
  const anyWaiting = data.projects.some(project => project.waiting > 0);
  const navTasks = ready ? data.tasks?.tasks || [] : [];
  const navWaiting = navTasks.filter(task => task.question && !task.question.answer).length;
  function renderProjectNav(rail) {
    if (projectLinks.length === 0) return null;
    return <nav aria-label="Project views" className={rail ? "hidden md:block" : "shrink-0 border-t bg-background px-3 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden"}>
      <div className={rail ? "flex flex-col gap-1" : "mx-auto grid max-w-3xl grid-cols-3 gap-1"}>
        {projectLinks.map(({ label, href, current }) => <a key={href} href={href} aria-current={current ? "page" : undefined}
          className={cn("flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            rail ? "justify-between" : "justify-center",
            current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
          {label}
          {rail && ready && label === "Tasks" && <>
            {navWaiting > 0 && <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-xs font-medium text-white">{navWaiting} need you</span>}
            <span className="text-xs">{navTasks.length}</span>
          </>}
          {rail && ready && label === "Patterns" && <span className="text-xs">{(data.patterns || []).length}</span>}
        </a>)}
      </div>
    </nav>;
  }
  return <SurfaceContext.Provider value={{ surfaces, submit: payload => action("a2ui", payload, "Sent"), disabled: !ready || working }}><div className="flex h-dvh w-full overflow-hidden">
    <aside className="hidden w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block"><Sidebar {...sidebarProps} projectNav={renderProjectNav(true)}/></aside>
    <Sheet open={navOpen} onOpenChange={setNavOpen}>
      <SheetContent side="left" className="w-[85vw] max-w-80 bg-sidebar p-0">
        <SheetTitle className="sr-only">Projects</SheetTitle>
        <SheetDescription className="sr-only">Pick a project or a session</SheetDescription>
        <Sidebar {...sidebarProps}/>
      </SheetContent>
    </Sheet>
    <OutcomeRequest project={outcomeProject} close={() => setOutcomeProject("")} disabled={working} error={outcomeError}
      submit={async fields => {
        setWorking(true);
        setOutcomeError("");
        try {
          await api("request-outcome", { project: outcomeProject, ...fields });
          setOutcomeProject("");
          navigate({ project: outcomeProject, level: "tasks" });
        } catch (err) { setOutcomeError(err.message); }
        finally { setWorking(false); }
      }}/>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/85 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/70">
        <div className={cn("flex items-center gap-2", level === "session" && "flex-wrap")}>
          <Button variant="ghost" size="icon" className="relative md:hidden" aria-label="Projects" aria-expanded={navOpen} onClick={() => setNavOpen(true)} title={anyWaiting ? "Sessions waiting on you" : undefined}>
            <Menu/>{anyWaiting && <span aria-hidden className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-background"/>}
          </Button>
          {/* Back one level: a session returns to its project chat, a project to Home. */}
          {(!home || inbox) && <Button variant="ghost" size="icon" aria-label={level === "session" ? "Back to " + project : "Home"} title={level === "session" ? "Back to the " + project + " chat" : "Home: every project's sessions"}
            onClick={() => navigate(level === "session" ? { project, level: "project" } : { level: "home" })}><ArrowLeft/></Button>}
          {level === "session" && selected.session && <Avatar address={selected.session} className="size-8 shrink-0"/>}
          <div className="min-w-0 flex-1">
            {level === "session" ? <>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h1 className="min-w-0 truncate text-lg font-semibold leading-tight" title={title}>{title}</h1>
                {agent && <StateChip state={sessionState(agent, now)}/>}
                {agent && <RunningCount runs={agent.subagents} now={now}/>}
              </div>
              <p className="truncate text-xs text-muted-foreground" title={selected.session}>
                {raw ? "Raw activity · " + project : project + " · session"}
                {identity && sessionLabel && sessionLabel !== identity && " · " + sessionLabel}
              </p>
            </> : <>
              <p className="truncate text-xs text-muted-foreground">{home ? "All projects" : patterns || tasksView ? "Project · " + project : "Project"}</p>
              <h1 className="truncate text-base font-semibold leading-tight">{title}</h1>
            </>}
            {level === "session" && agent?.parent && <button type="button" onClick={() => openAddress(agent.parent)} title={"Started by " + agent.parent}
              aria-label={"Back to parent " + agent.parent} className="flex max-w-full items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
              <CornerLeftUp className="size-3.5 shrink-0"/><span className="truncate">Back to parent {short(agent.parent)}</span></button>}
          </div>
          <div className={cn("flex shrink-0 items-center gap-2", level === "session" && "max-sm:w-full max-sm:justify-end")}>
            <AfkToggle mode={data.mode || "off"} disabled={!ready || working} set={mode => action("afk", { mode }, "AFK " + mode)}/>
            {/* Before the first state frame the bell shows this browser's last choice. */}
            <NotifyToggle level={data.alerts} levelDisabled={!ready || working} setLevel={level => action("alerts", { level }, "Alerts set")}/>
            <ThemeToggle/>
          </div>
        </div>
        {account.user && <p className="-mt-1 truncate text-right text-[11px] text-muted-foreground" data-account={account.user.login}>
          signed in as <span className="font-medium text-foreground" title={account.user.name || undefined}>{account.user.login}</span>
          {" · "}<button type="button" className="underline-offset-2 hover:underline" onClick={signOut}>sign out</button></p>}
        {level === "project" && ready && !data.hosted && !missing && <div className="flex items-center gap-2">
          {paused && <Badge variant="secondary">New work paused</Badge>}
          <Button variant="outline" size="sm" disabled={working}
            onClick={() => action("project-pause", { paused: !paused }, paused ? "New work resumed" : "New work paused")}>{paused ? "Resume new work" : "Pause new work"}</Button>
        </div>}
        {level === "session" && selected.session && <ZoomControls data={data} selected={selected} now={now} navigate={navigate}
          compact={level === "session" && agent?.session && <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {agent.modelControl && modelsOf(models, "claude").length > 0 && <select
              aria-label="Claude model" className="h-9 w-28 truncate rounded-full border bg-background px-2 text-sm"
              value={agent.modelControl.current} disabled={!ready || working || agent.modelControl.busy}
              onChange={event => action("model", { target: selected.session, model: event.target.value }, "Model switched")}>
              <option value="" disabled>Default model</option>
              {Array.from(new Set([agent.modelControl.current, ...modelsOf(models, "claude")])).filter(Boolean)
                .map(model => <option key={model} value={model}>{model}</option>)}
            </select>}
            <ContextChip context={agent.context || {}} rows={rows.filter(row => row.agent === agent.id)}/>
            {agent.online && ["codex", "opencode"].includes(agent.peer) && <Button variant="outline" size="sm" className="h-9 rounded-full" aria-label="Interrupt" disabled={!ready || working}
              onClick={() => action("interrupt", { target: selected.session }, "Interrupt requested")}><Square/>Interrupt</Button>}
            <SessionMenu node={{ ...agent, project }} disabled={working} map={() => navigate({ project, level: "compactions" })} dispose={node => action("dispose", { project: node.project, target: node.id }, "Disposed")}
              raw={openRaw} label={"Session actions for " + selected.session}/>
            <Button variant="outline" size="sm" className="h-9 rounded-full" aria-label="Compact" disabled={!ready || working}
              onClick={() => action("compact", { target: selected.session }, "Compaction requested")}><Minimize2/>Compact</Button></span>}/>}
        {!home && !listing && !tasksView && !patterns && !subagents && !raw && !compactions && <ConversationHistory key={requested} requested={requested}/>}
      </header>
      <div className={cn("flex flex-col gap-2 px-3 empty:hidden", composing && "min-h-0 flex-1 justify-center pb-[20vh]")}>
        {composing && <NewAgentComposer key={project + ":" + (data.startable || []).join(",")} project={project} startable={data.startable || []} places={data.startPlaces || ["folder"]} startPlace={data.startPlace || "folder"} sandboxHarnesses={data.openshellHarnesses || []}
          startDefault={data.startDefault} codeModeDefault={data.codeModeDefault !== false} agents={data.agents} models={models} disabled={!ready} start={startSession} close={() => setCreating("")} open={openAddress}/>}
        {agent?.wake?.status && <div className="mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-xl border bg-muted/50 px-3 py-2 text-sm">
          Wake · {agent.wake.status}{agent.wake.detail && " · " + agent.wake.detail}
          {agent.wake.status === "failed" && !agent.online && <Button size="sm" variant="outline" disabled={working} onClick={() => action("wake", { target: selected.session }, "Wake requested")}>Retry wake</Button>}
        </div>}
        {selected.window && <div className="mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-xl border bg-muted/50 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">One schedule run · {new Date(selected.window.from).toLocaleString()} to {new Date(selected.window.to).toLocaleString()}</span>
          <Button size="sm" variant="outline" onClick={() => navigate({ project, level: "session", harness: selected.harness, session: selected.session, tab: "activity" })}>Show all</Button>
        </div>}
        {loadError && <div role="alert" className="mx-auto mt-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <span className="flex-1">{loadError}</span>
          <Button size="sm" variant="outline" onClick={retry}><RotateCw/>Retry</Button>
        </div>}
      </div>
      {patterns && <div className="min-h-0 flex-1 overflow-y-auto">
        {ready ? <PatternsPage data={data} project={project} selected={selected} navigate={navigate} call={patternCall} disabled={working}/>
          : <p className="py-16 text-center text-sm text-muted-foreground">Loading patterns…</p>}
      </div>}
      {!patterns && !composing && (tasksView ? <TaskBoard key={project} project={project} board={ready ? data.tasks : null} now={now} taskId={selected.task} landControl={ready && <LandReviews landing={data.landing} disabled={working} onLand={() => action("land-reviews", {}, "Landing reviews")}/>}
        outcomeControls={{ act: action, disabled: working, paused }}
        back={() => navigate({ project, level: "tasks" })} compose={id => navigate({ project, level: "project", composeTask: id })}
        continuation={{ harnesses: paused ? [] : data.startable || [], launch: (id, harness) => action("continue-builder", { id, harness }, "Replacement started") }}
        inspect={id => navigate({ project, level: "tasks", task: id })}
        move={(id, status) => action("move-task", { id, status }, "Task moved")}
        recover={(id, harness) => action("recover-builder", { id, harness }, "Builder started")}
        decide={(id, answer) => action("decide", { id, answer }, "Decided")}
        review={(id, decision, note, packet) => action("review", { id, decision, note, ...packet }, decision === "accept" ? "Build accepted" : "Build returned")}
        skip={taskId => action("skip", { taskId }, "Skipped")}
        open={address => navigate({ project, level: "session", harness: address.split("#")[0], session: address, tab: "activity" })}/> : <ChatContainerRoot key={inbox ? "inbox" : home ? "home" : "conversation"} initial={home ? false : "instant"} contextRef={stick} className="relative min-h-0 flex-1" onTouchStart={pullStart} onTouchMove={pullMove} onTouchEnd={pullEnd} onTouchCancel={() => pullTo(0)}>
        <ChatContainerContent key={requested} className="mx-auto w-full max-w-3xl gap-5 px-3 py-4">
          {!ready && (home || listing || subagents || compactions) && !loadError && <p className="py-16 text-center text-sm text-muted-foreground">Loading sessions…</p>}
          {ready && (home || listing) && <>
            {home && data.unavailable?.length > 0 && <p role="alert" className="text-xs text-destructive">Unavailable: {data.unavailable.join(", ")}</p>}
            {home && !inbox && data.projects.filter(item => item.paused).map(item =>
              <button key={item.id} type="button" className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm"
                onClick={() => navigate({ project: item.id, level: "project" })}>
                <span className="truncate">{item.id}</span><Badge variant="secondary">New work paused</Badge>
              </button>)}
            {home && !inbox && <LandReviews landing={data.landing} disabled={working} onLand={() => action("land-reviews", { project: undefined }, "Landing reviews")}/>}
            {home && <DecisionQueue decisions={data.decisions} inbox={inbox} now={now} disabled={working} action={action}
              seen={seenDecisions} markSeen={markDecisionSeen} openInbox={() => navigate({ level: "inbox" })}/>}
            {home && !inbox && data.shipped?.length > 0 && <Shipped items={data.shipped}
              open={item => navigate({ project: item.project, level: "tasks", task: item.id })}/>}
            {!inbox && <SessionList sessions={data.sessions} now={now} open={openCard} raw={openRaw} disabled={working} showProject={home} compact={home}
              inactiveOpen={inactiveOpen} onInactiveToggle={rememberInactive}
              deadOpen={Boolean(views.get(memoryKey, {}).dead)} onDeadToggle={rememberDead}
              openAddress={(address, at) => navigate({ project: at, level: "session", harness: peerOf(address), session: address })}
              empty={home ? "No sessions in any project yet." : "No sessions in " + project + " yet."}
              dispose={node => action("dispose", { project: node.project, target: node.id }, "Disposed")}
              act={payload => action("approve", payload, "Sent")} answer={(at, id, body) => action("reply", { project: at, question: id, body }, "Reply sent")}
              skip={payload => action("skip", payload, "Skipped")}/>}
          </>}
          {ready && compactions && <CompactionMap agents={data.agents || []} now={now}/>}
          {ready && subagents && <SubagentList rows={rows} session={selected.session} run={selected.run} when={at => ago(at, now)} now={now}
            childRuns={(agent?.subagents || []).filter(run => run.child)} openChild={child => navigate({ project, level: "session", harness: child.kind, session: child.id })}
            back={() => navigate({ ...selected, project, tab: "activity", run: "" })}
            pick={run => navigate({ ...selected, project, tab: "subagents", run })}/>}
          {!home && !listing && !subagents && (!ready || thread.length + live.length === 0) && <p className="py-16 text-center text-sm text-muted-foreground">
            {ready ? (raw ? "No activity yet." : "No messages yet.") : loadError ? "" : watching ? "Loading project chat…" : "Loading conversation…"}</p>}
          {ready && !home && !listing && !subagents && thread.map(({ message, activity: row }) => row
            ? row.type === "completion" ? <CompletionRow key={row.id} row={row} when={at => ago(at, now)} open={openAddress}/>
              : <ActivityRow key={row.id} row={row} when={at => ago(at, now)} now={now} goRun={goRun}/>
            : <ChatMessage key={message.id} message={message} operator={data.operator} me={account.user?.login} now={now} open={openAddress} disabled={!ready || working} taskLinks={taskLinks}
              detail={agentDetail(data.agents.find(agent => agent.id === message.from))}
              act={payload => action("approve", payload, "Sent")} answer={(id, body) => action("reply", { question: id, body }, "Reply sent")}
              skip={payload => action("skip", payload, "Skipped")}
              reply={id => { setQuestion(id); setNotice(""); document.getElementById("composer")?.focus(); }}
              replyFrom={target => setReplyTo(target)}/>)}
          {ready && watching && live.map(row => <LiveRow key={row.id} row={row} open={openAddress}/>)}
          {ready && inline && <Working rows={rows} now={now}/>}
          <ChatContainerScrollAnchor/>
        </ChatContainerContent>
        <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 z-20 flex justify-center", pullSide === "top" ? "top-0" : "bottom-0")} style={{ transform: `translateY(${pullSide === "top" ? Math.min(pull, PULL_MAX_PX) - 44 : 44 - Math.min(pull, PULL_MAX_PX)}px)`, opacity: pull ? 1 : 0 }}>
          <span data-pull={pull >= PULL_THRESHOLD_PX ? "ready" : "pulling"} className={cn("grid size-9 place-items-center rounded-full border bg-card shadow-md", pull >= PULL_THRESHOLD_PX && "border-primary text-primary")}>
            <RotateCw className="size-4" style={{ transform: `rotate(${pull * 4}deg)` }}/></span>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <ScrollButton className="pointer-events-auto shadow-md" aria-label="Scroll to newest"/>
        </div>
      </ChatContainerRoot>)}
      <div role="status" hidden={!notice} className="mx-auto w-full max-w-3xl px-4 text-center text-xs text-muted-foreground">{notice}</div>
      {!composing && queue.length > 0 && <section aria-label="Queued messages" className="mx-auto w-full max-w-3xl border-t bg-background">
        <h2 className="px-3 py-1 text-xs font-medium text-muted-foreground">Queued messages ({queue.length})</h2>
        <ul className="max-h-48 overflow-y-auto">
          {queue.map(message => <QueueRow key={project + ":" + message.id} message={message} disabled={working || Boolean(message.by && message.by !== account.user?.login)}
            change={(item, queueAction, body) => action("queue", { target: item.to, id: item.id, queueAction, body },
              { edit: "Queue updated", cancel: "Message canceled", steer: "Prioritized for delivery" }[queueAction])}/>)}
        </ul>
      </section>}
      {!home && !listing && !patterns && !tasksView && !composing && <Composer key={requested + ":" + composeTask} conversation={conversationKey(project, composeTask ? "#" + composeTask : level === "session" ? selected.session : "")} initialDraft={composeTask ? `#${composeTask} ` : ""} disabled={!ready || working || missing} agents={data.agents} harnesses={data.harnesses} teams={data.teams} startable={data.startable} models={models} now={now} harness={level === "session" && agent?.peer || ""}
        placeholder={placeholder} routing={routing} question={question} cancel={() => setQuestion("")} urgentable={!question} replying={replyTo} cancelReply={() => setReplyTo(null)}
        onSend={async (body, urgent, command, sendAnyway) => {
          // Project chat never runs commands: a leading / there is ordinary chat.
          if (command && !question && level === "session" && selected.session) return runCommand(body);
          const composeHash = composeTask && location.hash;
          const sent = question ? await action("reply", { question, body }, "Reply sent")
            : await action("send", { target, body, ...(sendAnyway ? { sendAnyway: true } : {}), ...(urgent ? { urgent: true } : {}), ...(replyTo ? { replyTo: replyTo.id, quote: { sender: replyTo.sender, body: replyTo.body } } : {}) }, "Sent");
          if (sent === true) {
            setQuestion(""); setReplyTo(null); stick.current?.scrollToBottom();
            if (composeHash && location.hash === composeHash) navigate({ project, level: "project" });
          }
          return sent;
        }}/>}
      {renderProjectNav(false)}
    </main>
  </div></SurfaceContext.Provider>;
}
