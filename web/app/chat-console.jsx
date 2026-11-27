"use client";
// The console shell: hash routing, the header for each level, the streamed screen (via useStream),
// pull-to-refresh, scroll memory, and the wiring from every action to its /api call.
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Bot, CornerLeftUp, Menu, Minimize2, RotateCw, Square } from "lucide-react";
import { ThreadPrimitive, getExternalStoreMessages } from "@assistant-ui/react";
import { Avatar } from "./chat-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatContainerContent, ChatContainerRoot, ChatContainerScrollAnchor } from "@/components/ui/chat-container";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { contextMeter, filesRead } from "@/lib/context-view";
import { agentDetail } from "@/lib/agent-detail";
import { chatThread } from "@/lib/chat-turns";
import { NewAgentComposer } from "./new-session";
import { PatternsPage } from "./patterns-page";
import { LandReviews } from "./land-reviews";
import { DeployedBanner, Land } from "./land-panel";
import { OutcomeRequest } from "./outcomes";
import { TaskBoard } from "./tasks";
import { ProjectNav } from "./project-nav";
import { liveRows, projectThread, sessionTurns, withoutAnswered } from "@/lib/project-feed";
import { projectNavigation, projectViewCounts, selectionHash } from "@/lib/selection";
import { agentName } from "@/lib/sidebar";
import { sessionState } from "@/lib/session-state";
import { ActivityRow, Working } from "./activity";
import { RunRequests } from "./run-requests";
import { SurfaceContext } from "@/components/a2ui/surface";
import { NotifyToggle } from "./notify";
import { DecisionQueue } from "./decisions";
import { SessionList, SessionMenu, StateChip, SubagentList } from "./home";
import { RunningCount } from "./subagent-runs";
import { Shipped } from "./shipped";
import { CompactionMap } from "./compactions";
import { activityRows, groupSubagents } from "@/lib/activity-rows";
import { conversationKey, views } from "@/lib/view-memory";
import { ChatRuntimeProvider } from "@/components/chat/thread";
import { ago, peerOf, seatOf, short } from "./chat-shared";
import { api, selection, signOut, streamOf } from "./chat-api";
import { useStream } from "./chat-stream";
import { AfkToggle, Sidebar, ThemeToggle } from "./chat-sidebar";
import { ChatMessage, CompletionRow, LiveRow, QueueRow } from "./chat-message";
import { Composer, modelsOf, useModels } from "./chat-composer";

const PULL_THRESHOLD_PX = 70;
const PULL_MAX_PX = 110;
const TICK_MS = 1000;
// The composer's runtime only sends; the thread list has its own runtime.
const NO_ENTRIES = [];

// The session's context: tokens used (with the window and a warning when the harness reported one) and its files.
function ContextChip({ context, rows }) {
  const meter = contextMeter(context);
  const loaded = context.files || [];
  const read = filesRead(rows);
  const tone = meter.level === "full" ? "border-destructive text-destructive" : meter.level === "warn" ? "border-amber-500 text-amber-700 dark:text-amber-400" : "text-muted-foreground";
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

function ZoomControls({ data, selected, now, navigate, compact }) {
  const project = selected.project || data.project;
  // A picked project's own views are the rail beside the sidebar (the bottom bar on a phone), so the header keeps only
  // the session's views. A project has none, and an empty header row would only add a gap.
  if (!(selected.level === "session" && selected.session) && !compact) return null;
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

export function Console({ account }) {
  const [selected, setSelected] = useState(selection);
  const stick = useRef(null);
  const [pull, setPull] = useState(0);
  const pullFrom = useRef(null);
  const pullRef = useRef(0);
  const [pullSide, setPullSide] = useState("top");
  const [outcomeProject, setOutcomeProject] = useState("");
  const [outcomeError, setOutcomeError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [question, setQuestion] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const [creating, setCreating] = useState("");
  const [working, setWorking] = useState(false);
  const latestAction = useRef(0);
  const [now, setNow] = useState(Date.now);
  const route = useRef("");
  // The runtime's onNew bridge: the Composer registers its send handler here, so the primitive owns the
  // input state while the console keeps the send path (urgent, command, image flags live in the Composer).
  const sendBridgeRef = useRef(null);
  const { home, watching, subagents, inline, raw, listing, tasks, compactions, requested } = streamOf(selected);
  route.current = requested;
  // The live stream owns the screen it streams: data, activity, surfaces, readiness, and the reconnect ladder.
  const { data, activity, surfaces, ready, loadError, restore, retry } = useStream({ requested, route, account, onReady: () => setNow(Date.now()) });
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
      restore(nextStream);
      latestAction.current++;
      setNotice(""); setQuestion(""); setReplyTo(null); setNavOpen(false);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    // Relative times only; no network.
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
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
  const viewCounts = projectViewCounts(ready ? data : undefined);
  const agent = level === "session" ? data.agents.find(item => item.id === selected.session) : undefined;
  const target = level === "session" ? selected.session : "all";
  const missing = level === "session" && !target;
  const patterns = level === "patterns";
  const inbox = level === "inbox";
  const identity = agentName(agent);
  const sessionLabel = !agent?.generatedName ? agent?.name : "";
  // A picked project's own views read alike: the header's kicker names the project and its h1 the view. A session keeps
  // its own name; Home and the inbox are not inside a project.
  const projectView = level === "project" ? "Chat" : level === "tasks" ? "Tasks" : level === "patterns" ? "Teams" : "";
  const title = inbox ? "Decision inbox" : home ? "Home" : level === "session" ? identity || sessionLabel || short(selected.session) || "Sessions"
    : projectView || project;
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
    latestAction.current++;
    setWorking(true);
    try {
      const result = await api("command", { project, target: selected.session, command: body });
      if (at === route.current) setNotice([result.status, result.detail].filter(Boolean).join(" · "));
      return result.status === "succeeded" || result.status === "requested";
    } catch (err) { if (at === route.current) setNotice(err.message); return false; }
    finally { setWorking(false); }
  }
  async function action(path, payload, fallback, image) {
    const at = requested;
    const sequence = ++latestAction.current;
    const current = () => at === route.current && sequence === latestAction.current;
    const show = result => {
      if (!result || !current()) return;
      const outcome = (result.wake && !["online", "queued"].includes(result.wake.status) && result.wake) || result.compact || (result.wake ? { status: result.status, detail: result.detail } : result);
      const note = result.quoted ? [outcome.status || "Sent", "as plain text quoting the original"].join(" · ")
        : [outcome.status, outcome.detail || outcome.message || outcome.reason].filter(Boolean).join(" · ");
      setNotice(note || fallback);
    };
    setWorking(true);
    try {
      const result = await api(path, { project, ...payload }, image);
      if (result.draftHeld) return "draftHeld";
      show(result);
      void result.followup?.then(show);
      return true;
    } catch (err) { if (current()) setNotice(err.message); return false; }
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
  // Close, reopen and delete a project; Delete asks first and leaves the repo, worktrees and message history alone.
  async function projectAction(path, name) {
    if (path === "request-outcome") {
      setNavOpen(false);
      setOutcomeError("");
      setOutcomeProject(name);
      return;
    }
    if (path === "delete" && !window.confirm("Delete " + name + " from the project registry? Its repo, worktrees and message history stay. Live sessions in its repo will re-home under the folder name.")) return;
    const done = await action(path, { project: name }, path === "close" ? "Closed" : path === "reopen" ? "Reopened" : "Deleted");
    if (done && path !== "reopen" && name === (selected.project || data.project)) navigate({ level: "home" });
  }
  const sidebarProps = {
    inactiveOpen, onInactiveToggle: rememberInactive, data, selected, now, navigate, newSession, disabled: working,
    dispose: node => action("dispose", { project: node.project, target: node.id }, "Disposed"), openRaw, projectAction,
    openHash: hash => { setNavOpen(false); location.hash = hash.slice(1); },
  };
  const anyWaiting = data.projects.some(project => project.waiting > 0);
  // A picked project keeps its three views at every level inside it, so one list feeds the rail and the phone's bar.
  const navLinks = projectNavigation(project, level, viewCounts);
  return <SurfaceContext.Provider value={{ surfaces, submit: payload => action("a2ui", payload, "Sent"), disabled: !ready || working }}><div className="flex h-dvh w-full overflow-hidden">
    <aside aria-label="Projects and sessions" className="hidden w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block"><Sidebar {...sidebarProps}/></aside>
    <ProjectNav links={navLinks} rail/>
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
        <DeployedBanner deployed={data.deployed}/>
        <div className={cn("flex items-center gap-2", level === "session" && "flex-wrap")}>
          <Button variant="ghost" size="icon" className="relative md:hidden" aria-label="Projects" aria-expanded={navOpen} onClick={() => setNavOpen(true)} title={anyWaiting ? "Sessions waiting on you" : undefined}>
            <Menu/>{anyWaiting && <span aria-hidden className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-background"/>}
          </Button>
          {/* Back one level, the same step on every view: a session (or its compactions) returns to its project's chat, and
              a project view returns to Home. The rail's own links do the sideways moves between the project's views. */}
          {(!home || inbox) && <Button variant="ghost" size="icon" aria-label={level === "session" || level === "compactions" ? "Back to " + project : "Home"} title={level === "session" || level === "compactions" ? "Back to the " + project + " chat" : "Home: every project's sessions"}
            onClick={() => navigate(level === "session" || level === "compactions" ? { project, level: "project" } : { level: "home" })}><ArrowLeft/></Button>}
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
              <p className="truncate text-xs text-muted-foreground">{home ? "All projects" : project ? "Project · " + project : "Project"}</p>
              <h1 className="truncate text-base font-semibold leading-tight">{title}</h1>
            </>}
            {level === "session" && agent?.parent && <button type="button" data-tap onClick={() => openAddress(agent.parent)} title={"Started by " + agent.parent}
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
          {" · "}<button type="button" data-tap className="underline-offset-2 hover:underline" onClick={signOut}>sign out</button></p>}
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
        {!composing && <RunRequests requests={data.runRequests} now={now}/>}
      </div>
      {patterns && <div className="min-h-0 flex-1 overflow-y-auto">
        {ready ? <PatternsPage data={data} project={project} selected={selected} navigate={navigate} call={patternCall} disabled={working} models={models}/>
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
        <ChatRuntimeProvider key={requested} entries={thread} operator={data.operator}>
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
            {home && !inbox && <Land/>}
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
          {!home && !listing && !subagents && (!ready || (thread.length + live.length === 0 && (raw || queue.length === 0))) && <p className="py-16 text-center text-sm text-muted-foreground">
            {ready ? (raw ? "No activity yet." : "No messages yet.") : loadError ? "" : watching ? "Loading project chat…" : "Loading conversation…"}</p>}
          {ready && !home && !listing && !subagents && <ThreadPrimitive.Messages>
              {({ message }) => {
                const [entry] = getExternalStoreMessages(message) || [];
                if (!entry) return null;
                if (entry.activity) return entry.activity.type === "completion"
                  ? <CompletionRow row={{ ...entry.activity, seat: seatOf(data.agents, entry.activity.agent) }} when={at => ago(at, now)} open={openAddress}/>
                  : <ActivityRow row={entry.activity} when={at => ago(at, now)} now={now} goRun={goRun}/>;
                return <ChatMessage message={entry.message} operator={data.operator} me={account.user?.login} now={now} open={openAddress} disabled={!ready || working} taskLinks={taskLinks}
                  detail={agentDetail(data.agents.find(agent => agent.id === entry.message.from))}
                  act={payload => action("approve", payload, "Sent")} answer={(id, body) => action("reply", { question: id, body }, "Reply sent")}
                  skip={payload => action("skip", payload, "Skipped")}
                  reply={id => { setQuestion(id); setNotice(""); document.getElementById("composer")?.focus(); }}
                  replyFrom={target => setReplyTo(target)}/>;
              }}
            </ThreadPrimitive.Messages>}
          {ready && watching && live.map(row => <LiveRow key={row.id} row={{ ...row, seat: seatOf(data.agents, row.agent) }} open={openAddress}/>)}
          {ready && inline && <Working rows={rows} now={now}/>}
          <ChatContainerScrollAnchor/>
        </ChatContainerContent>
        </ChatRuntimeProvider>
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
      {!home && !listing && !patterns && !tasksView && !composing && <ChatRuntimeProvider key={requested + ":" + composeTask} entries={NO_ENTRIES} operator={data.operator} onSend={body => sendBridgeRef.current?.(body)}>
        <Composer sendBridgeRef={sendBridgeRef} conversation={conversationKey(project, composeTask ? "#" + composeTask : level === "session" ? selected.session : "")} initialDraft={composeTask ? `#${composeTask} ` : ""} disabled={!ready || working || missing} agents={data.agents} harnesses={data.harnesses} teams={data.teams} startable={data.startable} models={models} now={now} harness={level === "session" && agent?.peer || ""}
        placeholder={placeholder} routing={routing} question={question} cancel={() => setQuestion("")} urgentable={!question} replying={replyTo} cancelReply={() => setReplyTo(null)}
        onSend={async (body, urgent, command, sendAnyway, image) => {
          // Project chat never runs commands: a leading / there is ordinary chat.
          if (command && !question && level === "session" && selected.session) return runCommand(body);
          const composeHash = composeTask && location.hash;
          const sent = question ? await action("reply", { question, body }, "Reply sent")
            : await action("send", { target, body, ...(sendAnyway ? { sendAnyway: true } : {}), ...(urgent ? { urgent: true } : {}), ...(replyTo ? { replyTo: replyTo.id, quote: { sender: replyTo.sender, body: replyTo.body } } : {}) }, "Sent", image);
          if (sent === true && requested === route.current) {
            setQuestion(""); setReplyTo(null); stick.current?.scrollToBottom();
            if (composeHash && location.hash === composeHash) navigate({ project, level: "project" });
          }
          return sent;
        }}/>
      </ChatRuntimeProvider>}
      <ProjectNav links={navLinks}/>
    </main>
  </div></SurfaceContext.Provider>;
}
