"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Box, Check, ChevronDown, Folder, FolderGit2, FolderTree, GitBranch, GitPullRequest, Plus, type LucideIcon } from "lucide-react";
import { useAsyncOptions } from "@ui-sdk/react/async-options";
import { Combobox, ComboboxContent, ComboboxCreate, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxItemText, ComboboxList, ComboboxStatus, ComboboxTrigger } from "@ui-sdk/react/combobox";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { cn } from "@/lib/utils";
import { EMPTY_PICK, createOption, envOptions, prNumber, shortSha, triggerLabel, worktreeMarks, type EnvId, type Pick, type Pr, type Ref, type Worktree } from "@/lib/branch-picker";

const ENV_ICONS: Record<EnvId, LucideIcon> = { folder: Folder, worktree: FolderGit2, existing: FolderTree, openshell: Box };
const CONTROL = "inline-flex h-11 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm sm:h-8 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const POPUP = "z-50 rounded-xl border bg-popover p-1 text-popover-foreground shadow-md";
const ITEM = "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm outline-none sm:min-h-9 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:cursor-default data-disabled:opacity-60";
const MARK = "bg-transparent font-semibold text-foreground underline underline-offset-2";

type Option = { value: string; label: string; ref?: Ref; row?: Worktree };
type Listing = { current: string; truncated: boolean; gh: boolean; pr: Pr | null; branches: Ref[] };
type BranchesBody = { current: string; branches: Ref[]; truncated: boolean; gh: boolean; pr: Pr | null };
type WorktreesBody = { worktrees: Worktree[]; truncated: boolean };
type ToolbarProps = { project: string; places: string[]; env: EnvId; setEnv: (env: EnvId) => void; pick: Pick; setPick: (pick: Pick) => void; setCurrent: (current: string) => void; disabled?: boolean };

const EMPTY_LISTING: Listing = { current: "", truncated: false, gh: false, pr: null, branches: [] };

/** Where a new session starts: the environment select, then the branch or worktree it starts from. */
export function SessionToolbar({ project, places, env, setEnv, pick, setPick, setCurrent, disabled }: ToolbarProps) {
  const [current, setLocalCurrent] = useState("");
  const remember = (next: string) => { setLocalCurrent(next); setCurrent(next); };
  return <div role="group" aria-label="Where the session starts" className="flex min-w-0 items-center gap-1.5 px-1 pt-1.5">
    <EnvSelect places={places} env={env} setEnv={setEnv} disabled={disabled}/>
    {env === "worktree" || env === "existing"
      ? <BranchPicker key={env} project={project} env={env} pick={pick} setPick={setPick} current={current} setCurrent={remember} disabled={disabled}/>
      : <CurrentBranch project={project} env={env} current={current} setCurrent={remember}/>}
  </div>;
}

function EnvSelect({ places, env, setEnv, disabled }: { places: string[]; env: EnvId; setEnv: (env: EnvId) => void; disabled?: boolean }) {
  const options = envOptions(places);
  const Icon = ENV_ICONS[env];
  const label = options.find(option => option.id === env)?.label ?? "";
  // One place is not a choice, so it reads as text rather than a control.
  if (options.length < 2) {
    return <span className="inline-flex h-11 shrink-0 items-center gap-1.5 px-1 text-sm text-muted-foreground sm:h-8"><Icon aria-hidden="true" className="size-4"/>{label}</span>;
  }
  return <Select value={env} onValueChange={next => { if (next !== null) setEnv(next); }} items={options.map(option => ({ value: option.id, label: option.label }))} disabled={disabled}>
    <SelectTrigger aria-label="Environment" className={cn(CONTROL, "shrink-0")}>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/>
      <SelectValue/>
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/>
    </SelectTrigger>
    <SelectContent className={cn(POPUP, "min-w-52")}>
      {options.map(option => {
        const OptionIcon = ENV_ICONS[option.id];
        return <SelectItem key={option.id} value={option.id} label={option.label} className={ITEM}>
          <OptionIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          <SelectItemIndicator><Check aria-hidden="true" className="size-3.5 text-primary"/></SelectItemIndicator>
        </SelectItem>;
      })}
    </SelectContent>
  </Select>;
}

// Folder and OpenShell start from the checked-out branch; there is nothing to pick, so it is plain text.
function CurrentBranch({ project, env, current, setCurrent }: { project: string; env: EnvId; current: string; setCurrent: (current: string) => void }) {
  useEffect(() => {
    const controller = new AbortController();
    fetch(refsUrl(project, "branches", ""), { signal: controller.signal })
      .then(response => (response.ok ? response.json() as Promise<BranchesBody> : null))
      .then(body => { if (body) setCurrent(body.current); })
      .catch(() => {});
    return () => controller.abort();
  }, [project]);
  const text = triggerLabel(env, EMPTY_PICK, current);
  return <span aria-label={"Branch: " + text} className="inline-flex h-11 min-w-0 items-center gap-1.5 px-1 text-sm text-muted-foreground sm:h-8">
    <GitBranch aria-hidden="true" className="size-4 shrink-0"/><span className="truncate">{text}</span>
  </span>;
}

function BranchPicker({ project, env, pick, setPick, current, setCurrent, disabled }: { project: string; env: "worktree" | "existing"; pick: Pick; setPick: (pick: Pick) => void; current: string; setCurrent: (current: string) => void; disabled?: boolean }) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing>(EMPTY_LISTING);
  const worktrees = env === "existing";
  const options = useAsyncOptions<Option>(async (text, { signal }) => {
    const response = await fetch(refsUrl(project, worktrees ? "worktrees" : "branches", text), { signal });
    if (!response.ok) throw new Error("Could not load " + (worktrees ? "worktrees" : "branches"));
    if (worktrees) {
      const body = await response.json() as WorktreesBody;
      setListing(last => ({ ...last, truncated: body.truncated }));
      return body.worktrees.map(row => ({ value: row.path, label: row.branch ?? row.path, row }));
    }
    const body = await response.json() as BranchesBody;
    setListing({ current: body.current, truncated: body.truncated, gh: body.gh, pr: body.pr, branches: body.branches });
    setCurrent(body.current);
    return body.branches.map(ref => ({ value: ref.name, label: ref.name, ref }));
  }, { debounce: 150, immediate: true });
  const base = pick.base || current || "HEAD";
  const label = triggerLabel(env, pick, current);
  const pr = !worktrees && listing.gh && listing.pr && prNumber(query) === listing.pr.number ? listing.pr : null;
  const create = worktrees ? null : createOption(query, listing.branches, base);
  const noun = worktrees ? "worktrees" : "branches";

  function choose(value: string | null) {
    if (value === null) return;
    if (worktrees) setPick({ ...EMPTY_PICK, worktreePath: value });
    else if (value.startsWith("pr:")) { if (listing.pr?.base) setPick({ ...EMPTY_PICK, base: listing.pr.base }); }
    // Choosing a base drops a pending new branch name; the create row sets both.
    else setPick({ ...EMPTY_PICK, base: value });
  }

  return <Combobox<string> items={options.items} status={options.status} filter={false} disabled={disabled}
    value={(worktrees ? pick.worktreePath : pick.base) || null} onValueChange={choose}
    query={query} onQueryChange={text => { setQuery(text); options.setQuery(text); }}
    onOpenChange={open => { if (open) { setQuery(""); options.setQuery(""); } }}
    onOpenChangeComplete={open => { if (!open) button?.focus(); }}>
    <ComboboxTrigger ref={setButton} aria-label={(worktrees ? "Worktree: " : "Branch: ") + label} className={cn(CONTROL, "min-w-0 flex-1 sm:max-w-80 sm:flex-none")}>
      {worktrees ? <FolderTree aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/> : <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/>}
      <span className="min-w-0 truncate text-foreground">{label}</span>
      <ChevronDown aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground"/>
    </ComboboxTrigger>
    <ComboboxContent anchor={button} align="start" className={cn(POPUP, "flex w-[min(24rem,calc(100vw-1.5rem))] flex-col")}>
      <ComboboxInput autoFocus aria-label={worktrees ? "Search worktrees" : "Search branches"} placeholder={worktrees ? "Search worktrees" : "Search branches or type a new name"}
        className="h-10 w-full rounded-lg border-b bg-transparent px-2 text-base outline-none placeholder:text-muted-foreground sm:text-sm"/>
      <ComboboxStatus className="px-2 py-1 text-xs text-muted-foreground empty:hidden">
        {state => state.status === "error" ? "Could not load " + noun
          : state.loading ? "Loading " + noun
          : listing.truncated ? "Showing the 50 most recent; type to narrow" : ""}
      </ComboboxStatus>
      <ComboboxEmpty className="px-2 py-2 text-sm text-muted-foreground empty:hidden">
        {state => state.empty && !state.loading && !create && !pr ? (worktrees ? "No worktree matches" : "No branch matches") : null}
      </ComboboxEmpty>
      <ComboboxList className="max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain">
        {pr && <ComboboxItem value={"pr:" + pr.number} label={"#" + pr.number + " " + pr.title} disabled={pr.base === null} className={ITEM}>
          <GitPullRequest aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/>
          <span className="flex min-w-0 flex-1 flex-col py-1">
            <span className="truncate">#{pr.number} {pr.title}</span>
            <span className="truncate text-xs text-muted-foreground">{pr.base === null ? "Fetch this PR first" : "head " + pr.head}</span>
          </span>
        </ComboboxItem>}
        {options.items.map(option => option.row ? <WorktreeItem key={option.value} option={option} row={option.row}/> : <BranchItem key={option.value} option={option}/>)}
        {create && <ComboboxCreate onCreate={text => setPick({ ...EMPTY_PICK, base, branch: text.trim() })} className={ITEM}>
          <Plus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/>
          <span className="min-w-0 flex-1 truncate">Create branch <b className="font-semibold">{create.name}</b> from <b className="font-semibold">{create.base}</b></span>
        </ComboboxCreate>}
      </ComboboxList>
    </ComboboxContent>
  </Combobox>;
}

function BranchItem({ option }: { option: Option }) {
  return <ComboboxItem value={option.value} label={option.label} className={ITEM}>
    <Marked/>
    {option.ref?.remote && <span className="shrink-0 text-xs text-muted-foreground">remote</span>}
    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{shortSha(option.ref?.sha ?? "")}</span>
    <ComboboxItemIndicator><Check aria-hidden="true" className="size-3.5 text-primary"/></ComboboxItemIndicator>
  </ComboboxItem>;
}

function WorktreeItem({ option, row }: { option: Option; row: Worktree }) {
  return <ComboboxItem value={option.value} label={option.label} className={ITEM}>
    <span className="flex min-w-0 flex-1 flex-col py-1">
      {row.branch === null ? <span className="truncate">detached at {shortSha(row.head)}</span> : <Marked/>}
      <span title={row.path} className="truncate text-xs text-muted-foreground">{row.path}</span>
    </span>
    {worktreeMarks(row).map(mark => <span key={mark} className="shrink-0 rounded border px-1 text-xs text-muted-foreground">{mark}</span>)}
    <ComboboxItemIndicator><Check aria-hidden="true" className="size-3.5 text-primary"/></ComboboxItemIndicator>
  </ComboboxItem>;
}

// The item's label with the typed text marked, so a match is visible at a glance.
function Marked(): ReactNode {
  return <ComboboxItemText className="min-w-0 truncate">
    {state => state.segments.map((segment, index) => segment.match ? <mark key={index} className={MARK}>{segment.text}</mark> : segment.text)}
  </ComboboxItemText>;
}

function refsUrl(project: string, kind: "branches" | "worktrees", query: string) {
  return `/api/refs?project=${encodeURIComponent(project)}&kind=${kind}&q=${encodeURIComponent(query)}`;
}
