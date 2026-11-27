"use client";
// The composer: assistant-ui's ComposerPrimitive over the console's external-store runtime, with
// draft memory per conversation, the @mention and /command pickers, image drafts,
// and the destination line that says where the message will go before it is sent.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, AtSign, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fuzzyRank } from "@/lib/fuzzy";
import { commandFor, matchCommands } from "@/lib/slash-commands";
import { composerDestination, composerRecipients } from "@/lib/message-routing";
import { quotedReply, usableReplyId } from "@/lib/reply-quote";
import { patternMentionTargets } from "@/lib/mentions";
import { quoteText } from "@/lib/quote";
import { isLive } from "@/lib/session-state";
import { drafts } from "@/lib/view-memory";
import { AttachImageButton, ImageDraft, ImagePicker } from "./chat-image";
import { Avatar, Dot, HARNESS_NAMES, SessionName, seen, short } from "./chat-shared";

// Touch pointers insert a newline on Enter; the send button sends.
const COARSE_POINTER = "(pointer: coarse)";

// Model lists per harness from the models action; an empty object when it fails.
export function useModels(project) {
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

export const modelsOf = (models, harness) => Array.isArray(models[harness]) ? models[harness].filter(id => typeof id === "string" && id) : [];

export function Composer({ conversation, agents, harnesses, teams = [], startable = [], models = {}, now, disabled, placeholder, routing, onSend, urgentable, replying, cancelReply, harness = "", initialDraft = "", sendBridgeRef }) {
  // The draft lives in the runtime composer; the per-conversation store mirrors it so a view switch restores it.
  const aui = useAui();
  const draft = useAuiState(s => s.composer.text);
  const [urgent, setUrgent] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [held, setHeld] = useState(null);
  const [images, setImages] = useState([]);
  const [imageError, setImageError] = useState("");
  // Command names the picker inserted in this draft; only these and known commands make the message a command.
  const picked = useRef(new Set());
  const prefillFocused = useRef(false);
  const textarea = useRef(null);
  // The flags the runtime's onNew must carry back to the console's send path (the primitive only knows the text).
  const flags = useRef({});
  // Blocks a second image-only send before the first one's posting state renders.
  const pending = useRef(false);
  const coarse = useSyncExternalStore(subscribeCoarse, () => window.matchMedia?.(COARSE_POINTER).matches ?? false, () => false);
  // Seed the runtime composer from this conversation's stored draft once, before paint.
  useLayoutEffect(() => {
    const saved = drafts.get(conversation, "") || initialDraft;
    if (saved && !aui.composer.getState().text) aui.composer.setText(saved);
  }, []);
  // Every edit is kept per conversation, so a tab or view switch that remounts the composer restores it.
  const firstText = useRef(true);
  useEffect(() => {
    if (firstText.current) { firstText.current = false; return; }
    drafts.set(conversation, draft);
  }, [draft]);
  const mention = mentionAt(draft);
  const options = [...agents.map(agent => ({ id: agent.id, name: agent.name, lastMessageAt: agent.lastMessageAt, activeAt: agent.activeAt, online: agent.online, live: isLive(agent, now) })),
    ...harnesses.map(harness => ({ id: harness.id, lastMessageAt: harness.lastMessageAt, activeAt: harness.activeAt, harness: true })),
    ...(teams || []).map(team => ({ id: team.id, team: true, members: team.members })),
    ...patternMentionTargets(routing.patterns).filter(option => !(teams || []).some(team => team.id === option.id)),
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
  const image = images[0];
  const canSend = Boolean(text || image);
  const command = !image && routing.session && commandFor(text, picked.current) !== null;
  const route = { ...routing, agents, teams, startable, models, quoted, text: quoted ? quotedReply(text, replying) : text };
  const destination = command ? "Command for " + short(routing.target) : composerDestination(route);
  const recipients = command ? [routing.target] : composerRecipients(route);
  const sendName = command ? destination
    : "Send · " + destination;

  // Every edit is kept per conversation, so a tab or view switch that remounts the composer restores it.
  function setDraft(next) { setHeld(null); aui.composer.setText(next); }
  function focus() { document.getElementById("composer")?.focus(); }
  function selectImages(next) { setHeld(null); setImageError(""); setImages(next); }
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
  // The runtime's onNew path: the console's send runs with the flags set at send time;
  // a non-true result makes the provider throw MessageNotSentError, so the runtime hands the text back.
  async function finish(raw) {
    const body = raw.trim();
    setPosting(true);
    try {
      const { urgent: now, command, sendAnyway, image } = flags.current;
      // onSend returns true only when the message was sent (or a command ran or was requested); otherwise the draft stays.
      const result = await onSend(body, urgentable && now, command, sendAnyway, image);
      if (result === "draftHeld") setHeld({ text: body, replying, sendNow: now });
      if (result === true) {
        setShowPicker(false); setUrgent(false); picked.current.clear();
        if (image) selectImages([]);
      } else if (raw) drafts.set(conversation, raw);
      return result;
    } finally { setPosting(false); focus(); }
  }
  // The console's runtime bridge calls finish for every composer submission.
  useEffect(() => {
    sendBridgeRef.current = finish;
    return () => { if (sendBridgeRef.current === finish) sendBridgeRef.current = null; };
  });
  function send(sendAnyway = false, sendNow = urgent) {
    if (busy || !canSend) return;
    flags.current = { urgent: urgentable && sendNow, command, sendAnyway, image };
    // Text goes through the runtime (it owns clearing and draft-restoration); an image-only send has no text to hold.
    if (text) aui.composer.send();
    else if (!pending.current) {
      pending.current = true;
      void finish("").finally(() => { pending.current = false; });
    }
  }
  return <div className="relative mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
    {held?.text === draft.trim() && held.replying === replying && <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm">
      <span role="status">The terminal has an unsent draft.</span>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => send(true, held.sendNow)}>Send anyway</Button>
    </div>}
    {replying && <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border bg-muted px-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">Replying to {short(replying.sender)}{replying.body && <span className="text-muted-foreground"> · {quoteText(replying.body)}</span>}</span>
      <Button variant="ghost" size="icon" className="size-6" aria-label="Cancel reply" onClick={cancelReply}><X/></Button>
    </div>}
    {commandPicking && <div role="listbox" aria-label="Session commands"
      className="absolute inset-x-3 bottom-full mb-1 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {commands.map((command, i) => <button type="button" role="option" aria-selected={i === commandChosen} aria-disabled={command.status === "unsupported"} key={command.name}
        title={command.reason} onMouseDown={event => event.preventDefault()} onClick={() => command.status !== "unsupported" && insertCommand(command)}
        className={cn("flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm", i === commandChosen && "bg-accent text-accent-foreground", command.status === "unsupported" && "opacity-50")}>
        <span className="flex min-w-0 flex-1 flex-col"><span className="font-mono text-xs">/{command.name}{command.args ? " " + command.args : ""}</span>
          <span className="truncate text-xs text-muted-foreground">{command.summary}</span></span>
        {command.status === "partial" && <span className="shrink-0 rounded-md border px-1.5 text-xs text-primary">partial</span>}
        {command.status === "unverified" && <span className="shrink-0 rounded-md border px-1.5 text-xs text-primary">unverified</span>}
        {command.status === "unsupported" && <span className="shrink-0 text-xs text-muted-foreground">unsupported</span>}
      </button>)}
    </div>}
    {picking && <div role="listbox" aria-label="Mention an agent"
      className="absolute inset-x-3 bottom-full mb-1 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {matches.map((option, i) => <button type="button" role="option" aria-selected={i === chosen} key={option.id}
        onMouseDown={event => event.preventDefault()} onClick={() => insert(option)}
        className={cn("flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm", i === chosen && "bg-accent text-accent-foreground")}>
        <Avatar address={option.run ? option.owner : option.model ? option.harness : option.team ? "operator" : option.id} className="size-6 text-xs"/>
        <span className="flex min-w-0 flex-1 flex-col">{option.run ? <span className="truncate text-xs text-muted-foreground">{option.label}</span> : <span className="truncate font-mono text-xs">@{option.id}</span>}
          {option.run ? null : option.model ? <span className="truncate text-xs text-muted-foreground">{(HARNESS_NAMES[option.harness] || option.harness) + " · " + option.model}</span> : option.team ? <span className="truncate text-xs text-muted-foreground">{(option.members || []).join(", ")}</span> : <SessionName agent={option}/>}</span>
        {!option.harness && !option.run && !option.team && <Dot online={option.live === true}/>}
        <span className="shrink-0 text-xs text-muted-foreground">{option.run ? "subagent" : option.pattern ? "pattern" : option.team ? "team" : option.model ? "new session" : (option.harness ? "harness · " : "") + seen(option, now)}</span>
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
      <ImagePicker files={images} onChange={selectImages} onError={setImageError} disabled={busy}>
        <ComposerPrimitive.Root onSubmit={event => { event.preventDefault(); send(); }}
          className={cn("cursor-text rounded-3xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/50", busy && "cursor-not-allowed opacity-60")}>
          {image && <ImageDraft file={image} disabled={busy} remove={() => { selectImages([]); focus(); }}/>}
          {imageError && <p role="alert" className="px-3 text-sm text-destructive">{imageError}</p>}
          <div id="composer-destination" aria-live="polite" title={recipients.join(", ") || undefined} className="max-h-[20dvh] overflow-y-auto break-words px-3 pt-1 text-xs font-medium text-muted-foreground">
            {destination}
          </div>
          <ComposerPrimitive.Input ref={textarea} id="composer" aria-label="Message" aria-describedby="composer-destination" placeholder={placeholder} disabled={busy}
            submitMode={coarse ? "none" : "enter"} cancelOnEscape={false}
            unstable_focusOnRunStart={false} unstable_focusOnScrollToBottom={false} unstable_focusOnThreadSwitched={false}
            onChange={event => change(event.target.value)}
            className="max-h-60 min-h-[44px] w-full resize-none border-none bg-transparent px-3 text-base text-foreground shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0"/>
          <TooltipProvider>
            <div className="flex items-center justify-between px-1 pt-1">
              <div className="flex items-center gap-1">
                <AttachImageButton replacing={Boolean(image)}/>
                <Tooltip>
                  <TooltipTrigger asChild disabled={busy} onClick={event => event.stopPropagation()}>
                    <Button type="button" variant="ghost" size="sm" className="rounded-md" aria-expanded={picking} disabled={busy}
                      onClick={() => { setShowPicker(!showPicker); setActiveIndex(0); focus(); }}><AtSign/>Mention</Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Mention an agent</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex items-center gap-1">
                {urgentable && !command && <Tooltip>
                  <TooltipTrigger asChild disabled={busy} onClick={event => event.stopPropagation()}>
                    <Button type="button" variant={urgent ? "secondary" : "ghost"} size="sm" className={cn("rounded-md", urgent && "text-primary")} aria-pressed={routing.session ? undefined : urgent} disabled={busy || (routing.session && !canSend)}
                      onClick={() => routing.session ? send(false, true) : setUrgent(!urgent)}><Zap/>Send now</Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Deliver at the agent&apos;s next tool call instead of its next turn</TooltipContent>
                </Tooltip>}
                <Tooltip>
                  <TooltipTrigger asChild disabled={busy} onClick={event => event.stopPropagation()}>
                    <Button type="submit" size="icon" className="rounded-md" aria-label={sendName} disabled={busy || !canSend}><ArrowUp/></Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{sendName}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TooltipProvider>
        </ComposerPrimitive.Root>
      </ImagePicker>
    </div>
  </div>;
}

function subscribeCoarse(change) {
  const query = window.matchMedia?.(COARSE_POINTER);
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
}
