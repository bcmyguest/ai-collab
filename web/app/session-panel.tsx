"use client";
// The panel beside a thread's chat: its diff, its pull requests, the session's subagent activity, the project's tasks and raw tool calls.
// A side column from md up; a bottom sheet on a phone.
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, GitPullRequest, X } from "lucide-react";
import { useTheme } from "next-themes";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle } from "@ui-sdk/react/drawer";
import { cn } from "@/lib/utils";
import type { Thread } from "@/lib/thread-groups";
import { Counts } from "./tool-diff";

export const PANEL_TABS = [["diff", "Diff"], ["pr", "PR"], ["subagents", "Activity"], ["tasks", "Tasks"], ["raw", "Raw"]] as const;
export type PanelTab = (typeof PANEL_TABS)[number][0];
const PatchDiff = lazy(() => import("@pierre/diffs/react").then(mod => ({ default: mod.PatchDiff })));
const DIFF_OPTIONS = { overflow: "wrap", disableFileHeader: true, theme: { dark: "github-dark", light: "github-light" }, diffStyle: "unified" };
const FILE_START = /^diff --git /m;
const TAB = "inline-flex h-8 items-center rounded-sm px-2.5 text-sm text-muted-foreground hover:text-foreground data-selected:bg-primary/10 data-selected:text-primary data-selected:text-foreground max-md:h-11";
const PR_STATE = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } satisfies Record<string, string>;

type DiffFile = { path: string; text: string; added: number; removed: number };
type DiffState = { status: "idle" | "loading" | "done" | "error"; text?: string; error?: string };

// Shows the fallback when the lazy diff chunk fails to load or render.
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** One file per `diff --git` header, with its path and line counts. */
export function splitPatch(text: string): DiffFile[] {
  return text.split(FILE_START).filter(Boolean).map(chunk => {
    const body = "diff --git " + chunk;
    const lines = body.split("\n");
    const target = lines.find(line => line.startsWith("+++ "))?.slice(4).replace(/^b\//, "");
    const source = lines.find(line => line.startsWith("--- "))?.slice(4).replace(/^a\//, "");
    const header = /^diff --git a\/(.+?) b\//.exec(lines[0])?.[1] || "";
    const path = target && target !== "/dev/null" ? target : source && source !== "/dev/null" ? source : header;
    const hunk = lines.findIndex(line => line.startsWith("@@"));
    const changed = hunk < 0 ? [] : lines.slice(hunk);
    return { path, text: body, added: changed.filter(line => line.startsWith("+")).length, removed: changed.filter(line => line.startsWith("-")).length };
  });
}

function DiffView({ project, thread }: { project: string; thread?: Thread }) {
  const [state, setState] = useState<DiffState>({ status: "idle" });
  const { resolvedTheme } = useTheme();
  const options = useMemo(() => ({ ...DIFF_OPTIONS, themeType: resolvedTheme === "light" ? "light" : "dark" }), [resolvedTheme]);
  const id = thread?.id || "";
  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ status: "loading" });
    fetch("/api/thread-diff?" + new URLSearchParams({ project, thread: id }), { cache: "no-store" })
      .then(async response => {
        const text = await response.text();
        if (!live) return;
        if (response.ok) setState({ status: "done", text });
        else setState({ status: "error", error: (() => { try { return JSON.parse(text).error; } catch { return text; } })() || "The diff is unavailable" });
      })
      .catch(error => { if (live) setState({ status: "error", error: error.message }); });
    return () => { live = false; };
  }, [project, id]);
  if (!thread) return <Empty>This session belongs to no thread, so there is no branch to diff.</Empty>;
  if (state.status === "loading" || state.status === "idle") return <Empty>Loading the diff…</Empty>;
  if (state.status === "error") return <p role="alert" className="px-3 py-4 text-sm text-destructive">{state.error}</p>;
  const files = splitPatch(state.text || "");
  if (!files.length) return <Empty>No changes against {thread.baseRef || "the base branch"} yet.</Empty>;
  return <div className="flex min-w-0 flex-col gap-2 p-3">
    <p className="text-xs text-muted-foreground">{files.length} file{files.length === 1 ? "" : "s"} changed against <span className="font-mono">{thread.baseRef || "origin/HEAD"}</span></p>
    {files.map(file => {
      const plain = <pre className="overflow-x-auto px-2.5 py-1.5 font-mono text-xs">{file.text}</pre>;
      return <details key={file.path} open={files.length <= 8} className="group min-w-0 overflow-hidden rounded-md border bg-card text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 group-open:border-b [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"/>
          <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
          <Counts added={file.added} removed={file.removed} className=""/>
        </summary>
        <Boundary fallback={plain}>
          <Suspense fallback={plain}>
            <div className="min-w-0 [&_pre]:text-xs"><PatchDiff patch={file.text} options={options as never} disableWorkerPool/></div>
          </Suspense>
        </Boundary>
      </details>;
    })}
  </div>;
}

function PrView({ thread }: { thread?: Thread }) {
  if (!thread) return <Empty>This session belongs to no thread.</Empty>;
  if (!thread.prs?.length) return <Empty>No pull request is attached to this thread.</Empty>;
  return <ul className="flex flex-col divide-y">
    {thread.prs.map(pr => <li key={pr.id || pr.number} className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm">
      <GitPullRequest aria-hidden className={cn("size-4 shrink-0", pr.state === "open" ? "text-foreground" : "text-muted-foreground")}/>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">#{pr.number} · {PR_STATE[pr.state as keyof typeof PR_STATE] || pr.state}</span>
        {(pr.head || pr.base) && <span className="truncate font-mono text-xs text-muted-foreground" title={pr.head + " into " + pr.base}>{pr.head} → {pr.base}</span>}
      </span>
      {pr.url && <a href={pr.url} target="_blank" rel="noreferrer noopener" className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        Open<ExternalLink aria-hidden className="size-3"/></a>}
    </li>)}
  </ul>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

type PanelProps = {
  tab: PanelTab; setTab: (tab: PanelTab) => void; close: () => void; project: string; thread?: Thread; activity?: ReactNode; raw?: ReactNode;
  tasks: ReactNode; tabs?: PanelTab[];
};

function PanelBody({ tab, setTab, close, project, thread, activity, raw, tasks, tabs }: PanelProps) {
  return <Tabs value={tab} onValueChange={(next: unknown) => setTab(next as PanelTab)} className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <TabsList aria-label="Panel" className="flex flex-1 items-center gap-0.5">
        {PANEL_TABS.filter(([id]) => !tabs || tabs.includes(id)).map(([id, label]) => <TabsTab key={id} value={id} className={TAB}>{label}</TabsTab>)}
      </TabsList>
      <button type="button" aria-label="Close panel" onClick={close}
        className="grid size-8 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"><X aria-hidden className="size-4"/></button>
    </div>
    <TabsPanel value="diff" className="min-h-0 flex-1 overflow-y-auto">{tab === "diff" && <DiffView project={project} thread={thread}/>}</TabsPanel>
    <TabsPanel value="pr" className="min-h-0 flex-1 overflow-y-auto"><PrView thread={thread}/></TabsPanel>
    <TabsPanel value="subagents" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{tab === "subagents" && activity}</TabsPanel>
    <TabsPanel value="tasks" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{tab === "tasks" && tasks}</TabsPanel>
    <TabsPanel value="raw" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{tab === "raw" && raw}</TabsPanel>
  </Tabs>;
}

/** The panel as a right column (wide) or a bottom sheet (phone); `wide` comes from the console's media query. */
export function SessionPanel({ wide, ...props }: PanelProps & { wide: boolean }) {
  if (wide) return <aside aria-label="Thread panel" className="relative z-10 flex w-[min(34rem,40vw)] shrink-0 flex-col bg-card shadow-raised">
    <PanelBody {...props}/>
  </aside>;
  return <Drawer open onOpenChange={(open: boolean) => { if (!open) props.close(); }}>
    <DrawerBackdrop className="bg-black/30"/>
    <DrawerContent className="flex h-[85dvh] w-full flex-col rounded-t-3xl bg-card shadow-raised">
      <DrawerTitle className="sr-only">Thread panel</DrawerTitle>
      <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30"/>
      <PanelBody {...props}/>
    </DrawerContent>
  </Drawer>;
}
