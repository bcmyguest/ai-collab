"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Box, Check, ChevronDown, Folder, FolderGit2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { HarnessLogo } from "./logos";
import { cn } from "@/lib/utils";
import { CODE_MODE_START_HARNESSES, activeModel, codeModeField, flatModels, modeChoice, modeOptions, modelGroups, modelLabel, moveActive, placeOptions } from "@/lib/new-session";
import { initialChoice } from "@/lib/start-default";

export const PROMPT_PLACEHOLDER = "Plan, search, build anything";
const PLACE_ICONS = { folder: Folder, worktree: FolderGit2, openshell: Box };
const MODE_HINTS = { agent: "Build and edit", ask: "Answers, read-only", plan: "Plans, read-only" };

/** True on a touch-only screen (a phone), where Return types a newline and the round button sends. */
function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return coarse;
}

/** The round button at a pill row's start; the popover it opens carries the choices. */
function Pill({ open, label, className, children, ...props }) {
  return <PopoverTrigger asChild>
    <button type="button" aria-label={label} title={label} {...props}
      className={cn("flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-50",
        open && "bg-muted text-foreground", className)}>
      {children}
      <ChevronDown className="size-3 shrink-0 opacity-60"/>
    </button>
  </PopoverTrigger>;
}

/** A harness logo in a small disc, so a model row reads as its harness at a glance. */
function Mark({ harness }) {
  return <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-muted">
    <HarnessLogo peer={harness} className="size-2.5 text-foreground/70"/>
  </span>;
}

/** A menu heading above a run of rows. */
function MenuLabel({ children }) {
  return <p className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">{children}</p>;
}

function ModePill({ mode, harness, set }) {
  const [open, setOpen] = useState(false);
  const options = modeOptions(harness);
  const current = options.find(option => option.id === mode) || options[0];
  if (!current) return null;
  return <Popover open={open} onOpenChange={setOpen}>
    <Pill open={open} label={"Mode: " + current.label}>
      <span className="truncate font-medium text-foreground">{current.label}</span>
    </Pill>
    <PopoverContent className="w-56">
      <MenuLabel>Mode</MenuLabel>
      <div role="listbox" aria-label="Mode">
        {options.map(option => <button type="button" role="option" aria-selected={option.id === current.id} key={option.id}
          onClick={() => { set(option.id); setOpen(false); }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{option.label}</span>
            <span className="truncate text-xs text-muted-foreground">{MODE_HINTS[option.id] || option.id}</span>
          </span>
          {option.id === current.id && <Check className="size-3.5 shrink-0 text-primary"/>}
        </button>)}
      </div>
    </PopoverContent>
  </Popover>;
}

function ModelPill({ choice, startable, models, set }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // A fresh open starts from the whole list, like Cursor's model menu.
  useEffect(() => { if (!open) { setQuery(""); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  const groups = useMemo(() => modelGroups({ startable, models, query }), [startable, models, query]);
  const listed = useMemo(() => flatModels(groups), [groups]);
  // Where each harness's run starts in the flat list, so a row knows its keyboard index without a search.
  const offsets = useMemo(() => groups.map((_, i) => groups.slice(0, i).reduce((at, group) => at + group.models.length, 0)), [groups]);
  const pick = item => { set(item); setOpen(false); };
  const loading = Object.keys(models || {}).length === 0;
  // The keyboard position is clamped to the list, so a shorter result set never hides the highlight.
  const cursor = Math.min(active, Math.max(listed.length - 1, 0));
  return <Popover open={open} onOpenChange={setOpen}>
    <Pill open={open} label={"Model: " + modelLabel(choice)} className="min-w-0 flex-1 shrink sm:flex-none">
      <Mark harness={choice.harness}/>
      <span className="min-w-0 max-w-40 truncate font-medium text-foreground sm:max-w-56">{modelLabel(choice)}</span>
    </Pill>
    <PopoverContent className="w-[min(22rem,calc(100vw-1.5rem))] p-0">
      <div className="border-b p-2">
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { setActive(moveActive(cursor, 1, listed.length)); event.preventDefault(); }
            else if (event.key === "ArrowUp") { setActive(moveActive(cursor, -1, listed.length)); event.preventDefault(); }
            else if (event.key === "Enter") {
              const item = activeModel(listed, cursor);
              if (item) { pick(item); event.preventDefault(); }
            }
          }}
          aria-label="Search models" placeholder="Search models" role="combobox" aria-expanded="true" aria-controls="model-list"
          className="h-8 w-full rounded-lg bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"/>
      </div>
      <div id="model-list" role="listbox" aria-label="Models" className="max-h-72 overflow-y-auto p-1">
        {listed.length === 0 ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          {loading ? "Models are still loading." : "No model matches."}</p>
          : groups.map((group, groupIndex) => <div key={group.harness} role="group" aria-label={group.label}>
            <MenuLabel>{group.label}</MenuLabel>
            {group.models.map((model, indexInGroup) => {
              const selected = group.harness === choice.harness && model === choice.model;
              const index = offsets[groupIndex] + indexInGroup;
              return <button type="button" role="option" aria-selected={selected} key={group.harness + ":" + model}
                onMouseEnter={() => setActive(index)} onClick={() => pick({ harness: group.harness, model })}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                  index === cursor && "bg-accent text-accent-foreground")}>
                <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", selected && "font-semibold")}>{model}</span>
                {selected && <Check className="size-3.5 shrink-0 text-primary"/>}
              </button>;
            })}
          </div>)}
      </div>
    </PopoverContent>
  </Popover>;
}

/** Native code mode on or off for this start; shown only for a harness whose start can use it. */
function CodeModePill({ harness, on, set }) {
  if (!CODE_MODE_START_HARNESSES.includes(harness)) return null;
  const label = "Code mode: " + (on ? "on" : "off");
  return <button type="button" aria-label={label} title={label} aria-pressed={on} onClick={() => set(!on)}
    className={cn("flex h-7 shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
      on && "text-foreground")}>
    {"{}"}<span className="truncate">{on ? "Code" : "Code off"}</span>
  </button>;
}

function PlacePill({ place, places, set }) {
  const [open, setOpen] = useState(false);
  const options = placeOptions(places);
  const current = options.find(option => option.id === place) || options[0];
  if (!current) return null;
  const Icon = PLACE_ICONS[current.id] || Folder;
  // One place is not a choice; the pill then only says where the session starts.
  return <Popover open={open} onOpenChange={setOpen}>
    <Pill open={open} label={"Start in: " + current.name} disabled={options.length < 2}
      title={options.length < 2 ? "Start in: " + current.name : undefined}
      className={cn(options.length < 2 && "cursor-default [&_svg:last-child]:hidden")}>
      <Icon className="size-3.5 shrink-0"/><span className="max-w-24 truncate text-foreground">{current.label}</span>
    </Pill>
    {options.length > 1 && <PopoverContent className="w-60">
      <MenuLabel>Start in</MenuLabel>
      <div role="listbox" aria-label="Start in">
        {options.map(option => {
          const OptionIcon = PLACE_ICONS[option.id] || Folder;
          return <button type="button" role="option" aria-selected={option.id === current.id} key={option.id}
            onClick={() => { set(option.id); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent">
            <OptionIcon className="size-4 shrink-0 text-muted-foreground"/>
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {option.id === current.id && <Check className="size-3.5 shrink-0 text-primary"/>}
          </button>;
        })}
      </div>
    </PopoverContent>}
  </Popover>;
}

/**
 * The new-agent dialogue, shaped like Cursor's composer: the prompt first, then one pill row (mode, model, place) with
 * a round send button at its end. The harness comes from the chosen model, never from text typed into the prompt.
 */
export function NewAgentComposer({ project, agents = [], startable = [], places = ["folder"], models = {}, startDefault, codeModeDefault = true, disabled, start, close, open }) {
  const [choice, setChoice] = useState(() => initialChoice({ startable, models, setting: startDefault }));
  const [codeMode, setCodeMode] = useState(codeModeDefault !== false);
  const [mode, setMode] = useState(() => modeChoice("agent", choice.harness));
  const [place, setPlace] = useState(() => (places.includes("folder") ? "folder" : places[0] || "folder"));
  const [result, setResult] = useState(null);
  const [posting, setPosting] = useState(false);
  const [draft, setDraft] = useState("");
  // A picked model or harness outranks the configured default when the model lists arrive later.
  const picked = useRef(false);
  const busy = disabled || posting;
  const coarse = useCoarsePointer();
  // The session's chat opens once its status arrives, as the old panel did; a failed start keeps the panel.
  const joined = result?.session && agents.some(agent => agent.id === result.session) ? result.session : "";

  useEffect(() => {
    if (!joined) return;
    close();
    open(joined);
  }, [joined]);
  useEffect(() => {
    // A pick outranks the default, but only while the project can still start it (a peer removed, a CLI gone).
    if (picked.current && startable.includes(choice.harness)) return;
    picked.current = false;
    const next = initialChoice({ startable, models, setting: startDefault });
    setChoice(current => (current.harness === next.harness && current.model === next.model ? current : next));
  }, [startable, models, startDefault, choice.harness]);
  // A harness change keeps the mode when it still supports it, else takes its first.
  useEffect(() => { setMode(current => modeChoice(current, choice.harness)); }, [choice.harness]);
  // A place can vanish when the project's snapshot changes (a sandbox stopped, a worktree no longer possible).
  useEffect(() => { setPlace(current => (places.includes(current) ? current : places[0] || "folder")); }, [places.join(",")]);

  const canSend = !busy && Boolean(draft.trim()) && Boolean(choice.harness);
  const failure = result && result.status !== "started" ? [result.status, result.detail].filter(Boolean).join(" · ") : "";

  async function submit() {
    const prompt = draft.trim();
    if (!canSend || !prompt) return;
    setPosting(true);
    setResult(null);
    try {
      const payload = { harness: choice.harness, prompt, startMode: mode, ...(place !== "folder" ? { place } : {}), ...(choice.model ? { model: choice.model } : {}), ...codeModeField(choice.harness, codeMode) };
      const next = await start(payload);
      setResult(next);
      if (next?.status === "started") setDraft("");
    } catch (error) {
      setResult({ status: "failed", detail: error.message });
    } finally {
      setPosting(false);
    }
  }
  // Enter sends from a keyboard; Shift+Enter keeps the newline; Escape closes. A phone's return key types a newline,
  // because there the send button is the way to submit.
  function onKeyDown(event) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (coarse || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }

  return <section aria-label="New session" className="mx-auto mt-2 w-full max-w-3xl">
    <div className="rounded-2xl border bg-card p-2 shadow-sm focus-within:border-ring/60">
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <h2 className="min-w-0 truncate text-xs text-muted-foreground">New session in <span className="font-medium text-foreground">{project}</span></h2>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close new session" disabled={posting} onClick={close}><X/></Button>
      </div>
      {startable.length === 0 ? <p className="px-2 pb-2 pt-1 text-sm text-muted-foreground">No harness is installed and configured for this project.</p>
        : <>
          <Textarea id="new-agent-prompt" aria-label="Prompt" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown}
            placeholder={PROMPT_PLACEHOLDER} disabled={busy} rows={3} autoFocus
            className="min-h-24 resize-none border-0 bg-transparent px-2 py-1 text-base shadow-none field-sizing-content focus-visible:ring-0 md:text-[15px] dark:bg-transparent"/>
          <div className="flex items-center gap-1 px-0.5 pt-1">
            <ModePill mode={mode} harness={choice.harness} set={setMode}/>
            <ModelPill choice={choice} startable={startable} models={models} set={item => { picked.current = true; setChoice(item); }}/>
            <PlacePill place={place} places={places} set={setPlace}/>
            <CodeModePill harness={choice.harness} on={codeMode} set={setCodeMode}/>
            <Button type="button" size="icon" aria-label="Start session" disabled={!canSend} onClick={submit}
              className="ml-auto size-8 shrink-0 rounded-full"><ArrowUp/></Button>
          </div>
        </>}
    </div>
    {failure && <p role="status" data-new-session-status="failed" className="px-2 pt-1.5 text-xs text-destructive">{failure}</p>}
    {result?.status === "started" && <p role="status" data-new-session-status="started" className="px-2 pt-1.5 text-xs text-muted-foreground">
      {[result.detail, result.warning].filter(Boolean).join(" · ")}{result.session && !joined ? " · waiting for " + result.session.split("#")[1] + " to report" : ""}</p>}
  </section>;
}
