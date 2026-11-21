"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { HarnessLogo, hasLogo } from "./logos";
import { Activity, ArrowLeft, ArrowUp, AtSign, Bell, BellOff, Bot, Check, CheckCheck, Coffee, CornerLeftUp, FolderGit2, Menu, Minimize2, Monitor, Moon, Plus, RotateCw, Sun, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatContainerContent, ChatContainerRoot, ChatContainerScrollAnchor } from "@/components/ui/chat-container";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import { PromptInput, PromptInputAction, PromptInputActions, PromptInputTextarea } from "@/components/ui/prompt-input";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fuzzyRank } from "@/lib/fuzzy";
import { ActivityRow, GoToAgent, Working } from "./activity";
import { ApprovalCard, QuestionCard } from "./cards";
import { NotifyToggle } from "./notify";
import { SessionList, SubagentList } from "./home";
import { Textarea } from "@/components/ui/textarea";
import { activityRows, groupSubagents, interleave, runningSubagents } from "@/lib/activity-rows";
import { toast } from "sonner";

const initial = { projects: [], harnesses: [], agents: [], messages: [] };
const ACTIVITY_MAX = 500;
const PULL_THRESHOLD_PX = 70;
const PULL_MAX_PX = 110;
const LEVELS = [["project", "Project"], ["session", "Sessions"]];
// Tabs other than chat each level accepts in the hash.
const TABS = { project: ["activity"], session: ["activity", "subagents"] };
const DEFAULT_MODEL = "default";
const PLACES = { folder: "In the project folder", worktree: "In a new git worktree", openshell: "In the openshell sandbox" };
const HARNESS_COLORS = {
  claude: "[&_[data-slot=avatar-fallback]]:bg-claude", codex: "[&_[data-slot=avatar-fallback]]:bg-codex",
  cursor: "[&_[data-slot=avatar-fallback]]:bg-cursor", opencode: "[&_[data-slot=avatar-fallback]]:bg-opencode", operator: "[&_[data-slot=avatar-fallback]]:bg-primary",
};
const CONNECTION_TOAST = "connection";
const UPDATE_TOAST = "update";
const BUILD = process.env.AI_COLLAB_BUILD;
const QUIET_RETRY_MS = 500;
const RECONNECT_GRACE_MS = 3_000;
const STALE_AFTER_MS = 20_000;
const TICK_MS = 1000;
const AFK_MODES = [["off", "Off", Bell], ["on", "On", Coffee], ["quiet", "Quiet", BellOff]];
const HARNESS_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
const RECEIPTS = { sent: ["Sent", Check], delivered: ["Delivered", CheckCheck], read: ["Read", CheckCheck] };
const clock = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
// Fired on a 401 or a closed stream; the sign-in gate asks /api/auth/me again.
const AUTH_CHECK = "ai-collab:auth-check";

function selection() {
  const params = new URLSearchParams(location.hash.slice(1));
  const level = params.get("level");
  // An empty hash, #home, or level=home opens the Home overview of every project.
  if (!location.hash.slice(1) || params.has("home") || level === "home") return { project: "", level: "home", harness: "", session: "", tab: "chat", run: "" };
  const tab = params.get("tab");
  const at = LEVELS.some(([id]) => id === level) ? level : "project";
  return {
    project: params.get("project") || "",
    level: at,
    harness: params.get("harness") || "",
    session: params.get("session") || "",
    tab: (TABS[at] || []).includes(tab) ? tab : "chat",
    run: at === "session" && tab === "subagents" ? params.get("run") || "" : "",
  };
}

/** The /api/events query for a selection, and which view it shows. */
function streamOf(selected) {
  const stream = new URLSearchParams();
  const home = selected.level === "home";
  const session = selected.level === "session" && Boolean(selected.session);
  if (selected.project && !home) stream.set("project", selected.project);
  if (session) stream.set("session", selected.session);
  // The project's Activity tab is the overview; a session's Activity tab interleaves its rows with its chat.
  const watching = selected.tab === "activity" && selected.level === "project";
  const subagents = session && selected.tab === "subagents";
  const inline = session && selected.tab === "activity";
  // Sessions with none picked lists the project's sessions under the selector.
  const listing = selected.level === "session" && !selected.session;
  if (watching || inline || subagents) stream.set("view", "activity");
  else if (home) stream.set("view", "home");
  else if (listing) stream.set("view", "sessions");
  return { home, watching, subagents, inline, listing, requested: stream.toString() };
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

/** Marks @peer and @peer#session tags as "#mention" links so Markdown colours only the tag. */
function withMentions(body) {
  return String(body).replace(/(^|[\s(])@([a-z][\w-]*(?:#[a-f0-9]{16})?)(?![\w#])/g, "$1[@$2](#mention)");
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
  const label = by ? by.slice(0, 2).toUpperCase() : peer === "operator" ? "You" : peer.slice(0, 2).toUpperCase();
  const fallback = !by && hasLogo(peer) ? <HarnessLogo peer={peer} className="size-[55%]"/> : label;
  return <MessageAvatar fallback={fallback} className={cn("size-8 text-[11px] font-semibold [&_[data-slot=avatar-fallback]]:text-white", colorOf(address), className)}/>;
}

function Dot({ online }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground/40")}/>;
}

// Operator away mode, broadcast to every project's agents.
function AfkToggle({ mode, disabled, set }) {
  const Icon = AFK_MODES.find(([id]) => id === mode)?.[2] || Bell;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant={mode === "off" ? "ghost" : "secondary"} size="sm" className="rounded-full" aria-label={"AFK mode: " + mode} disabled={disabled}>
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
  return agent?.name ? <span className="line-clamp-2 min-w-0 break-words text-xs text-foreground/80">{agent.name}</span> : null;
}

function Sidebar({ data, selected, now, navigate, newSession }) {
  const current = selected.project || data.project;
  return <nav aria-label="Projects" className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4">
    <button type="button" onClick={() => navigate({ level: "home" })} aria-current={selected.level === "home" ? "page" : undefined}
      className="flex items-center gap-2 rounded-xl px-2 text-left text-sm font-semibold tracking-tight" title="Home: every project's sessions">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">ai</span>AI Collab
    </button>
    <section>
      <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Projects</h2>
      <ul className="flex flex-col gap-1">
        {data.projects.map(project => <li key={project.id} className="flex items-center gap-1">
          <button type="button" aria-current={project.id === current ? "page" : undefined}
            onClick={() => navigate({ project: project.id, level: "project" })}
            className={cn("flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent",
              project.id === current && "bg-sidebar-accent font-medium")}>
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground"/>
            <span className="min-w-0 flex-1 truncate">{project.id}</span>
            <span aria-hidden className="text-xs text-muted-foreground" title="Peers">{project.peers.length || ""}</span>
          </button>
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" aria-label={"New session in " + project.id}
            title="New session" onClick={() => newSession(project.id)}><Plus/></Button>
        </li>)}
      </ul>
    </section>
    <section>
      <button type="button" aria-current={selected.level === "project" && selected.tab === "activity" ? "page" : undefined}
        onClick={() => navigate({ project: current, level: "project", tab: "activity" })}
        className={cn("flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent",
          selected.level === "project" && selected.tab === "activity" && "bg-sidebar-accent font-medium")}>
        <Activity className="size-4 shrink-0 text-muted-foreground"/>
        <span className="min-w-0 flex-1 truncate">Activity</span>
        <span className="text-xs text-muted-foreground">all agents</span>
      </button>
    </section>
    <section>
      <div className="flex items-center justify-between px-2 pb-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sessions</h2>
        <button type="button" onClick={() => navigate({ project: current, level: "session" })} aria-current={selected.level === "session" && !selected.session ? "page" : undefined}
          className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">All sessions</button>
      </div>
      {data.agents.length === 0 && <p className="px-2 text-sm text-muted-foreground">No sessions seen yet.</p>}
      <ul className="flex flex-col gap-1">
        {data.agents.map(agent => <li key={agent.id}>
          <button type="button" aria-label={agent.id} title={agent.parent ? agent.id + " · started by " + agent.parent : agent.id} aria-current={selected.level === "session" && selected.session === agent.id ? "page" : undefined}
            onClick={() => navigate({ project: current, level: "session", harness: agent.peer, session: agent.id })}
            className={cn("flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent",
              selected.level === "session" && selected.session === agent.id && "bg-sidebar-accent")}>
            <Avatar address={agent.id} className="size-6 text-[9px]"/>
            <span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-mono text-xs">{short(agent.id)}</span><SessionName agent={agent}/></span>
            <Dot online={agent.online}/>
            <span className="shrink-0 text-right text-[11px] leading-tight text-muted-foreground">{ago(agent.lastMessageAt, now)}{agent.activeAt ? <><br/>active {ago(agent.activeAt, now)}</> : null}</span>
          </button>
        </li>)}
      </ul>
    </section>
  </nav>;
}

function ZoomControls({ data, selected, now, navigate, compact }) {
  const project = selected.project || data.project;
  return <div className="flex flex-wrap items-center gap-2">
    {/* Projects and sessions live in the sidebar (the menu on a phone); the header keeps only the view tabs. */}
    {selected.level === "session" && selected.session && <Tabs value={selected.tab} onValueChange={tab => navigate({ ...selected, project, tab, run: "" })}>
      <TabsList aria-label="Session view" className="h-9">
        <TabsTrigger value="chat" className="px-3">Chat</TabsTrigger>
        <TabsTrigger value="activity" className="px-3"><Activity/>Activity</TabsTrigger>
        <TabsTrigger value="subagents" className="px-3"><Bot/>Subagents</TabsTrigger>
      </TabsList>
    </Tabs>}
    {compact}
    {selected.level === "project" && <Tabs value={selected.tab} onValueChange={tab => navigate({ ...selected, project, tab })}>
      <TabsList aria-label="View" className="h-9">
        <TabsTrigger value="chat" className="px-3">Chat</TabsTrigger>
        <TabsTrigger value="activity" className="px-3"><Activity/>Activity</TabsTrigger>
      </TabsList>
    </Tabs>}
  </div>;
}

// WhatsApp-style ticks on the operator's own messages: ✓ sent, ✓✓ delivered, primary ✓✓ read.
function Ticks({ state }) {
  const [label, Icon] = RECEIPTS[state] || [];
  if (!Icon) return null;
  return <span role="img" aria-label={label} title={label} data-receipt={state}
    className={cn("inline-flex", state === "read" ? "text-primary" : "text-muted-foreground")}><Icon className="size-3.5"/></span>;
}

function ChatMessage({ message, operator, me, now, reply, open, act, answer, nudge, disabled }) {
  const sender = message.from || message.sender || "ntfy";
  const outgoing = sender === operator;
  // A signed-in family member's message names them; the viewer's own stays "You".
  const other = message.by && message.by !== me ? message.by : "";
  const label = ["Question", "Reply", "Approval"].includes(message.kind) ? message.kind + " · " + (message.by || short(sender)) : short(sender);
  const at = message.time ? message.time * 1000 : 0;
  // An agent's avatar and name open its session (or harness) view; the operator's own and ntfy posts stay plain.
  const openable = !outgoing && sender !== "ntfy" && sender !== "operator";
  const go = () => open(sender);
  return <Message className={cn("max-w-full", outgoing && "flex-row-reverse")}
    onClick={event => { const tag = event.target.closest?.("[data-mention]"); if (tag) open(tag.textContent.replace(/^@/, "")); }}>
    {openable ? <button type="button" aria-label={"Open avatar " + sender} tabIndex={-1} className="shrink-0 self-start rounded-full" onClick={go}><Avatar address={sender}/></button> : <Avatar address={sender} by={other}/>}
    <div className={cn("flex min-w-0 max-w-[82%] flex-col gap-1", outgoing ? "items-end" : "items-start")}>
      <div className="flex max-w-full flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {openable ? <button type="button" aria-label={"Open " + sender} title={sender} onClick={go}
          className="font-medium text-foreground underline-offset-2 hover:underline">{label}</button>
          : <span className="font-medium text-foreground" title={message.by ? sender + " · " + message.by : sender}>{outgoing ? other || "You" : label}</span>}
        {message.to && message.to !== "all" && <span title={message.to}>→ {short(message.to)}</span>}
        {at > 0 && <time dateTime={new Date(at).toISOString()} title={clock.format(at)}>{ago(at, now)}</time>}
        {message.scope === "all" && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">to all</Badge>}
        {message.urgent && <span role="img" aria-label="Sent now" title="Sent now: delivered at the agent's next tool call" data-urgent className="text-amber-500"><Zap className="size-3.5"/></span>}
        {outgoing && <Ticks state={message.receipt}/>}
        {/* Unread by its session: queued for the agent's next poll; Send now delivers it at the next tool call. */}
        {outgoing && message.to?.includes("#") && message.receipt && message.receipt !== "read" && <span data-queued className="flex items-center gap-1">
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">queued</Badge>
          {!message.urgent && nudge && <button type="button" disabled={disabled} onClick={() => nudge(message.to)}
            title="Deliver at the agent's next tool call" className="flex items-center gap-0.5 rounded-full px-1 text-amber-600 hover:bg-muted disabled:opacity-50 dark:text-amber-400">
            <Zap className="size-3"/>Send now</button>}
        </span>}
        {openable && sender.includes("#") && <GoToAgent onClick={go} className="size-6"/>}
      </div>
      {message.kind === "Approval" ? <ApprovalCard approval={message.approval} now={now} disabled={disabled} act={act}/>
        : message.kind === "Question" && message.question ? <QuestionCard body={withMentions(message.body)} answer={message.answer} by={message.answeredBy} disabled={disabled} onAnswer={body => answer(message.question, body)}/>
        : <MessageContent markdown className={cn("bubble max-w-full rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed shadow-xs [overflow-wrap:anywhere]",
        outgoing ? "rounded-tr-md border border-primary/25 bg-primary/10 text-foreground" : "rounded-tl-md border bg-card text-card-foreground",
        message.kind === "Question" && "border-amber-500/50")}>{withMentions(message.body)}</MessageContent>}
      {message.attachment && <a href={"/api/file/" + message.attachment.file} target="_blank" rel="noreferrer" className="block max-w-full overflow-hidden rounded-2xl border bg-card">
        <img src={"/api/file/" + message.attachment.file} alt={message.attachment.name} loading="lazy" className="block max-h-96 w-auto max-w-full object-contain"/>
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

function NewSession({ project, harnesses, places = ["folder"], agents, models, disabled, start, close, open }) {
  const [harness, setHarness] = useState(harnesses[0] || "");
  const [place, setPlace] = useState("folder");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const joined = result?.session && agents.find(agent => agent.id === result.session);
  const choices = modelsOf(models, harness);
  async function submit() {
    setBusy(true);
    const options = { ...(place === "worktree" ? { worktree: true } : place === "openshell" ? { openshell: true } : {}), ...(model !== DEFAULT_MODEL && choices.includes(model) ? { model } : {}) };
    try { setResult(await start({ harness, prompt: prompt.trim(), ...options })); } finally { setBusy(false); }
  }
  return <section aria-label="New session" className="mx-auto mt-2 flex w-full max-w-3xl flex-col gap-2 rounded-xl border bg-card px-3 py-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-medium">New session in {project}</h2>
      <Button variant="ghost" size="sm" onClick={close}>Close</Button>
    </div>
    {harnesses.length === 0 ? <p className="text-muted-foreground">No harness is installed and configured for this project.</p> : <>
      <Select value={harness} onValueChange={next => { setHarness(next); setModel(DEFAULT_MODEL); }}>
        <SelectTrigger aria-label="Harness to start" className="h-9 w-full sm:w-64"><SelectValue placeholder="Pick a harness"/></SelectTrigger>
        <SelectContent position="popper">{harnesses.map(id => <SelectItem key={id} value={id}>{HARNESS_NAMES[id] || id}</SelectItem>)}</SelectContent>
      </Select>
      {choices.length > 0 && <Select value={model} onValueChange={setModel}>
        <SelectTrigger aria-label="Model" className="h-9 w-full sm:w-64"><SelectValue/></SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={DEFAULT_MODEL}>Default model</SelectItem>
          {choices.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}
        </SelectContent>
      </Select>}
      {places.length > 1 && <Select value={place} onValueChange={setPlace}>
        <SelectTrigger aria-label="Where to start" className="h-9 w-full sm:w-64"><SelectValue/></SelectTrigger>
        <SelectContent position="popper">{places.map(id => <SelectItem key={id} value={id}>{PLACES[id] || id}</SelectItem>)}</SelectContent>
      </Select>}
      <Textarea aria-label="First prompt" placeholder="First prompt: keep it self-contained" value={prompt} onChange={event => setPrompt(event.target.value)} className="min-h-20 text-sm"/>
      <Button size="sm" className="self-start rounded-full" disabled={disabled || busy || !harness || !prompt.trim()} onClick={submit}>Start</Button>
    </>}
    {result && <p role="status" className={cn("text-xs", result.status === "started" ? "text-muted-foreground" : "text-destructive")}>
      {[result.status, result.detail, result.warning].filter(Boolean).join(" · ")}
      {result.session && !joined && " · waiting for " + short(result.session) + " to report"}
      {joined && <Button variant="link" size="sm" className="h-auto px-1 text-xs" onClick={() => open(result.session)}>Open {short(result.session)}</Button>}
    </p>}
  </section>;
}

function Composer({ agents, harnesses, startable = [], models = {}, now, disabled, placeholder, onSend, question, cancel, urgentable }) {
  const [draft, setDraft] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [posting, setPosting] = useState(false);
  const pending = useRef(false);
  const mention = mentionAt(draft);
  const options = [...agents.map(agent => ({ id: agent.id, name: agent.name, lastMessageAt: agent.lastMessageAt, activeAt: agent.activeAt, online: agent.online })),
    ...harnesses.map(harness => ({ id: harness.id, lastMessageAt: harness.lastMessageAt, activeAt: harness.activeAt, harness: true })),
    ...startable.flatMap(harness => modelsOf(models, harness).map(model => ({ id: harness + ":" + model, harness, model })))];
  // "@codex g5" narrows to codex's models; "@gpt" ranks every option.
  const matches = fuzzyRank(mention ? mention[1] + (mention[2] ?? "") : "", mention?.[2] !== undefined ? options.filter(option => option.model && option.harness === mention[1]) : options,
    option => [option.id, option.name, HARNESS_NAMES[option.harness === true ? option.id : option.harness], option.model]);
  const picking = showPicker && matches.length > 0;
  const chosen = Math.min(activeIndex, matches.length - 1);
  const busy = disabled || posting;

  function focus() { document.getElementById("composer")?.focus(); }
  // The @tag being typed: [tag text, first word, second word when the first names a startable harness].
  function mentionAt(text) {
    const found = /(?:^|\s)@([\w#:./-]*)(?: ([\w.:/-]+))?$/.exec(text);
    return found && (found[2] === undefined || startable.includes(found[1])) ? [found[0].replace(/^\s/, ""), found[1], found[2]] : null;
  }
  function change(next) { setDraft(next); setShowPicker(mentionAt(next) !== null); setActiveIndex(0); }
  function insert(option) {
    const prefix = mention ? draft.slice(0, -mention[0].length) : draft + (draft && !/\s$/.test(draft) ? " " : "");
    setDraft(prefix + "@" + option.id + " ");
    setShowPicker(false);
    focus();
  }
  async function send() {
    if (pending.current || busy || !draft.trim()) return;
    pending.current = true;
    setPosting(true);
    try { if (await onSend(draft.trim(), urgentable && urgent)) { setDraft(""); setShowPicker(false); setUrgent(false); } }
    finally { pending.current = false; setPosting(false); focus(); }
  }
  return <div className="relative mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
    {question && <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">Replying to question {question}</span>
      <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
    </div>}
    {picking && <div role="listbox" aria-label="Mention an agent"
      className="absolute inset-x-3 bottom-full mb-1 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {matches.map((option, i) => <button type="button" role="option" aria-selected={i === chosen} key={option.id}
        onMouseDown={event => event.preventDefault()} onClick={() => insert(option)}
        className={cn("flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm", i === chosen && "bg-accent text-accent-foreground")}>
        <Avatar address={option.model ? option.harness : option.id} className="size-6 text-[9px]"/>
        <span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-mono text-xs">@{option.id}</span>
          {option.model ? <span className="truncate text-xs text-foreground/80">{(HARNESS_NAMES[option.harness] || option.harness) + " · " + option.model}</span> : <SessionName agent={option}/>}</span>
        {!option.harness && <Dot online={option.online}/>}
        <span className="shrink-0 text-xs text-muted-foreground">{option.model ? "new session" : (option.harness ? "harness · " : "") + seen(option, now)}</span>
      </button>)}
    </div>}
    <div onKeyDownCapture={event => {
      if (!picking) return;
      if (event.key === "Escape") setShowPicker(false);
      else if (event.key === "ArrowDown") setActiveIndex((chosen + 1) % matches.length);
      else if (event.key === "ArrowUp") setActiveIndex((chosen + matches.length - 1) % matches.length);
      else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") insert(matches[chosen]);
      else return;
      event.preventDefault(); event.stopPropagation();
    }}>
      <PromptInput value={draft} onValueChange={change} onSubmit={send} disabled={busy} className="rounded-3xl bg-card shadow-sm">
        <PromptInputTextarea id="composer" aria-label="Message" placeholder={placeholder} className="text-[15px]"/>
        <PromptInputActions className="justify-between px-1 pt-1">
          <PromptInputAction tooltip="Mention an agent">
            <Button type="button" variant="ghost" size="sm" className="rounded-full" aria-expanded={picking} disabled={busy}
              onClick={() => { setShowPicker(!showPicker); setActiveIndex(0); focus(); }}><AtSign/>Mention</Button>
          </PromptInputAction>
          <div className="flex items-center gap-1">
            {urgentable && <PromptInputAction tooltip="Deliver at the agent's next tool call instead of its next turn">
              <Button type="button" variant={urgent ? "secondary" : "ghost"} size="sm" className={cn("rounded-full", urgent && "text-amber-500")} aria-pressed={urgent} disabled={busy}
                onClick={() => setUrgent(!urgent)}><Zap/>Send now</Button>
            </PromptInputAction>}
            <PromptInputAction tooltip="Send">
              <Button type="button" size="icon" className="rounded-full" aria-label="Send" disabled={busy || !draft.trim()} onClick={send}><ArrowUp/></Button>
            </PromptInputAction>
          </div>
        </PromptInputActions>
      </PromptInput>
    </div>
  </div>;
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
  const [data, setData] = useState(initial);
  const [activity, setActivity] = useState([]);
  const [pull, setPull] = useState(0);
  const pullFrom = useRef(null);
  const pullRef = useRef(0);
  const [pullSide, setPullSide] = useState("top");
  const stick = useRef(null);
  const [ready, setReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [question, setQuestion] = useState("");
  const [creating, setCreating] = useState("");
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const route = useRef("");
  const retrying = useRef(false);
  const shown = useRef(false);
  const autoRetry = useRef(true);
  const hiddenAt = useRef(0);
  const { home, watching, subagents, inline, listing, requested } = streamOf(selected);
  route.current = requested;
  // A new view opens at its newest message and follows new ones, even if the last view was scrolled up.
  useEffect(() => { if (ready) stick.current?.scrollToBottom("instant"); }, [ready, requested]);
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
      setActivity([]); setReady(false); setLoadError(""); setNotice(""); setQuestion(""); setNavOpen(false);
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
    const source = new EventSource("/api/events?" + requested);
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
    // EventSource reopens itself after a server restart; each opening checks the build once.
    let checked = false;
    source.addEventListener("open", () => { checked = false; });
    source.addEventListener("state", event => {
      if (requested !== route.current) return;
      if (!checked) { checked = true; checkBuild(); }
      clearTimeout(bannerTimer);
      setData(JSON.parse(event.data)); setReady(true); setLoadError(""); setNow(Date.now());
      // A healthy stream needs no toast; clear a "Reconnect failed" one.
      toast.dismiss(CONNECTION_TOAST);
      retrying.current = false; shown.current = false; autoRetry.current = true;
    });
    source.addEventListener("activity", event => {
      if (requested !== route.current) return;
      const { reset, items } = JSON.parse(event.data);
      setActivity(list => (reset ? items : [...list, ...items]).slice(-ACTIVITY_MAX));
    });
    source.addEventListener("problem", event => { source.close(); fail(JSON.parse(event.data).error); });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        if (account.enabled) window.dispatchEvent(new Event(AUTH_CHECK));
        if (autoRetry.current && !retrying.current) { autoRetry.current = false; retryTimer = setTimeout(() => setRevision(n => n + 1), QUIET_RETRY_MS); return; }
        return fail("Connection closed");
      }
      if (retrying.current) return fail("Server unreachable. Still retrying automatically.");
      if (!bannerTimer) bannerTimer = setTimeout(() => show("Reconnecting…"), RECONNECT_GRACE_MS);
    };
    // Phones suspend background pages and can leave a dead stream open; reconnect quietly on return.
    const resume = () => {
      if (document.visibilityState === "hidden") { hiddenAt.current = Date.now(); return; }
      const away = hiddenAt.current && Date.now() - hiddenAt.current > STALE_AFTER_MS;
      hiddenAt.current = 0;
      if (source.readyState === EventSource.CLOSED || away) reconnect();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", reconnect);
    return () => {
      clearTimeout(bannerTimer); clearTimeout(retryTimer); source.close();
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
    if (next.level === "home") { location.hash = "home"; return; }
    const params = new URLSearchParams();
    for (const key of ["project", "level", "harness", "session"]) if (next[key]) params.set(key, next[key]);
    if ((TABS[next.level || "project"] || []).includes(next.tab)) params.set("tab", next.tab);
    if (next.tab === "subagents" && next.run) params.set("run", next.run);
    location.hash = params.toString();
  }
  const project = selected.project || data.project || "";
  const models = useModels(project);
  const level = selected.level;
  const agent = level === "session" ? data.agents.find(item => item.id === selected.session) : undefined;
  const target = level === "session" ? selected.session : "all";
  const missing = level === "session" && !target;
  const title = home ? "Home" : level === "session" ? short(selected.session) || "Sessions" : project;
  // A home or Sessions card opens its session, or one of its subagent runs.
  const openCard = (node, run = "") => navigate({ project: node.project, level: "session", harness: node.harness || peerOf(node.id), session: node.id, ...(run ? { tab: "subagents", run } : {}) });
  const placeholder = missing ? "Pick a session first" : level === "session" ? "Message " + short(selected.session) + " directly…"
    : "Message everyone in " + (project || "the project") + "…";
  async function action(path, payload, fallback) {
    const at = requested;
    setWorking(true);
    try {
      const result = await api(path, { project, ...payload });
      if (at === route.current) {
        // A running session needs no wake note; its message's ticks tell the rest.
        const outcome = (result.wake && !["online", "queued"].includes(result.wake.status) && result.wake) || result.compact || (result.wake ? { status: result.status, detail: result.detail } : result);
        setNotice([outcome.status, outcome.detail || outcome.message || outcome.reason].filter(Boolean).join(" · ") || fallback);
      }
      return true;
    } catch (err) { if (at === route.current) setNotice(err.message); return false; }
    finally { setWorking(false); }
  }
  // Overview rows name their agent (tap opens its session thread); its newest row shows a badge counting running subagents.
  const agentLink = (address, id) => <><button type="button" aria-label={"Open activity for " + address} title={address}
    onClick={() => navigate({ project, level: "session", harness: peerOf(address), session: address, tab: "activity" })}
    className="flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-2 font-mono text-foreground hover:bg-accent">
    <Avatar address={address} className="size-5 text-[8px]"/>{short(address)}</button>
    <GoToAgent onClick={() => navigate({ project, level: "session", harness: peerOf(address), session: address, tab: "activity" })} className="size-6"/>
    {running.get(address) > 0 && newest.get(address) === id && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]" title="Running subagents">{running.get(address)} subagent{running.get(address) === 1 ? "" : "s"}</Badge>}</>;
  // A tapped sender or @tag: a session address opens its thread, a bare harness name the session list.
  function openAddress(address) {
    const [peer, session] = String(address).split("#");
    if (!peer || peer === "all" || peer === "operator" || peer === "ntfy") return;
    navigate(session ? { project, level: "session", harness: peer, session: address } : { project, level: "session" });
  }
  const rows = useMemo(() => watching || inline || subagents ? groupSubagents(activityRows(activity)) : [], [activity, watching, inline, subagents]);
  const running = runningSubagents(rows, now);
  const goRun = row => navigate({ project, level: "session", harness: peerOf(row.agent), session: row.agent, tab: "subagents", run: row.run });
  const newest = new Map(rows.map(row => [row.agent, row.id]));
  // The overview interleaves only the operator's own messages with every agent's activity.
  const thread = interleave(watching ? data.messages.filter(item => item.from === data.operator || item.kind === "Approval") : data.messages, rows);
  const newSession = id => { setCreating(id); if (id !== project || level !== "project") navigate({ project: id, level: "project" }); else setNavOpen(false); };
  async function startSession(payload) {
    try { return await api("start", { project, ...payload }); } catch (err) { return { status: "failed", detail: err.message }; }
  }
  const sidebar = <Sidebar data={data} selected={selected} now={now} navigate={navigate} newSession={newSession}/>;
  return <div className="flex h-dvh w-full overflow-hidden">
    <aside className="hidden w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block">{sidebar}</aside>
    <Sheet open={navOpen} onOpenChange={setNavOpen}>
      <SheetContent side="left" className="w-[85vw] max-w-80 bg-sidebar p-0">
        <SheetTitle className="sr-only">Projects</SheetTitle>
        <SheetDescription className="sr-only">Pick a project or a session</SheetDescription>
        {sidebar}
      </SheetContent>
    </Sheet>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/85 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/70">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Projects" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Menu/></Button>
          {/* Back one level: a session returns to its project chat, a project to Home. */}
          {!home && <Button variant="ghost" size="icon" aria-label={level === "session" ? "Back to " + project : "Home"} title={level === "session" ? "Back to the " + project + " chat" : "Home: every project's sessions"}
            onClick={() => navigate(level === "session" ? { project, level: "project" } : { level: "home" })}><ArrowLeft/></Button>}
          {level === "session" && selected.session && <Avatar address={selected.session} className="size-8 shrink-0"/>}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted-foreground">{home ? "All projects" : level === "project" ? (watching ? "Activity · all agents" : "Project") : project + " · session"}</p>
            <h1 className="truncate text-base font-semibold leading-tight" title={level === "session" ? selected.session : undefined}>{title}</h1>
            {level === "session" && agent?.name && <p className="line-clamp-2 break-words text-xs text-muted-foreground" title={agent.name}>{agent.name}</p>}
            {level === "session" && agent?.parent && <button type="button" onClick={() => openAddress(agent.parent)} title={"Started by " + agent.parent}
              aria-label={"Back to parent " + agent.parent} className="flex max-w-full items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
              <CornerLeftUp className="size-3.5 shrink-0"/><span className="truncate">Back to parent {short(agent.parent)}</span></button>}
          </div>
          {level === "session" && agent && <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={agent.online ? "online" : "offline"}>
            <Dot online={agent.online}/><span className="hidden sm:inline">{agent.online ? "online" : "offline"}</span></span>}
          <AfkToggle mode={data.mode || "off"} disabled={!ready || working} set={mode => action("afk", { mode }, "AFK " + mode)}/>
          <NotifyToggle/>
          <ThemeToggle/>
        </div>
        {account.user && <p className="-mt-1 truncate text-right text-[11px] text-muted-foreground" data-account={account.user.login}>
          signed in as <span className="font-medium text-foreground" title={account.user.name || undefined}>{account.user.login}</span>
          {" · "}<button type="button" className="underline-offset-2 hover:underline" onClick={signOut}>sign out</button></p>}
        {!home && <ZoomControls data={data} selected={selected} now={now} navigate={navigate}
          compact={level === "session" && agent?.session && <Button variant="outline" size="sm" className="ml-auto h-9 rounded-full" aria-label="Compact" disabled={!ready || working}
            onClick={() => action("compact", { target: selected.session }, "Compaction requested")}><Minimize2/>Compact</Button>}/>}
      </header>
      <div className="flex flex-col gap-2 px-3 empty:hidden">
        {creating && creating === project && ready && <NewSession key={project + ":" + (data.startable || []).join(",")} project={project} harnesses={data.startable || []} places={data.startPlaces}
          agents={data.agents} models={models} disabled={!ready} start={startSession} close={() => setCreating("")} open={openAddress}/>}
        {agent?.wake?.status && <div className="mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-xl border bg-muted/50 px-3 py-2 text-sm">
          Wake · {agent.wake.status}{agent.wake.detail && " · " + agent.wake.detail}
          {agent.wake.status === "failed" && !agent.online && <Button size="sm" variant="outline" disabled={working} onClick={() => action("wake", { target: selected.session }, "Wake requested")}>Retry wake</Button>}
        </div>}
        {loadError && <div role="alert" className="mx-auto mt-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <span className="flex-1">{loadError}</span>
          <Button size="sm" variant="outline" onClick={retry}><RotateCw/>Retry</Button>
        </div>}
      </div>
      <ChatContainerRoot contextRef={stick} className="relative min-h-0 flex-1" onTouchStart={pullStart} onTouchMove={pullMove} onTouchEnd={pullEnd} onTouchCancel={() => pullTo(0)}>
        <ChatContainerContent key={requested} className="mx-auto w-full max-w-3xl gap-5 px-3 py-4">
          {!ready && (home || listing || subagents) && !loadError && <p className="py-16 text-center text-sm text-muted-foreground">Loading sessions…</p>}
          {ready && (home || listing) && <>
            {home && data.unavailable?.length > 0 && <p role="alert" className="text-xs text-destructive">Unavailable: {data.unavailable.join(", ")}</p>}
            <SessionList sessions={data.sessions} now={now} open={openCard} disabled={working} showProject={home}
              openAddress={(address, at) => navigate({ project: at, level: "session", harness: peerOf(address), session: address })}
              empty={home ? "No sessions in any project yet." : "No sessions in " + project + " yet."}
              act={payload => action("approve", payload, "Sent")} answer={(at, id, body) => action("reply", { project: at, question: id, body }, "Reply sent")}/>
          </>}
          {ready && subagents && <SubagentList rows={rows} session={selected.session} run={selected.run} when={at => ago(at, now)} now={now}
            back={() => navigate({ ...selected, project, tab: "chat", run: "" })}
            pick={run => navigate({ ...selected, project, tab: "subagents", run })}/>}
          {!home && !listing && !subagents && (!ready || thread.length === 0) && <p className="py-16 text-center text-sm text-muted-foreground">
            {ready ? (watching ? "No activity yet." : "No messages yet.") : loadError ? "" : watching ? "Loading activity…" : "Loading conversation…"}</p>}
          {ready && !home && !listing && !subagents && thread.map(({ message, activity: row }) => row
            ? <ActivityRow key={row.id} row={row} when={at => ago(at, now)} agent={watching ? agentLink : undefined} now={now} goRun={goRun}/>
            : <ChatMessage key={message.id} message={message} operator={data.operator} me={account.user?.login} now={now} open={openAddress} disabled={!ready || working}
              act={payload => action("approve", payload, "Sent")} answer={(id, body) => action("reply", { question: id, body }, "Reply sent")}
              nudge={to => action("nudge", { target: to }, "Sending now")}
              reply={id => { setQuestion(id); setNotice(""); document.getElementById("composer")?.focus(); }}/>)}
          {ready && (watching || inline) && <Working rows={rows} now={now} overview={watching}/>}
          <ChatContainerScrollAnchor/>
        </ChatContainerContent>
        <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 z-20 flex justify-center", pullSide === "top" ? "top-0" : "bottom-0")} style={{ transform: `translateY(${pullSide === "top" ? Math.min(pull, PULL_MAX_PX) - 44 : 44 - Math.min(pull, PULL_MAX_PX)}px)`, opacity: pull ? 1 : 0 }}>
          <span data-pull={pull >= PULL_THRESHOLD_PX ? "ready" : "pulling"} className={cn("grid size-9 place-items-center rounded-full border bg-card shadow-md", pull >= PULL_THRESHOLD_PX && "border-primary text-primary")}>
            <RotateCw className="size-4" style={{ transform: `rotate(${pull * 4}deg)` }}/></span>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <ScrollButton className="pointer-events-auto shadow-md" aria-label="Scroll to newest"/>
        </div>
      </ChatContainerRoot>
      <div role="status" hidden={!notice} className="mx-auto w-full max-w-3xl px-4 text-center text-xs text-muted-foreground">{notice}</div>
      {!home && !listing && <Composer key={requested} disabled={!ready || working || missing} agents={data.agents} harnesses={data.harnesses} startable={data.startable} models={models} now={now}
        placeholder={placeholder} question={question} cancel={() => setQuestion("")} urgentable={!question}
        onSend={async (body, urgent) => {
          const sent = question ? await action("reply", { question, body }, "Reply sent") : await action("send", { target, body, ...(urgent ? { urgent: true } : {}) }, "Sent");
          if (sent) { setQuestion(""); stick.current?.scrollToBottom(); }
          return sent;
        }}/>}
    </main>
  </div>;
}
