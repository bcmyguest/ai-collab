import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { runState } from "@/lib/activity-rows";
import { runningCount, splitIdleRuns } from "@/lib/subagent-state";

/** "2 running" for a session's subagent runs; nothing when none run. */
export function RunningCount({ runs = [], now }) {
  const count = runningCount(runs, now);
  return count ? <Badge variant="secondary" className="h-4 shrink-0 whitespace-nowrap px-1.5 text-[10px]" title="Running subagents">{count} running</Badge> : null;
}

/** A session's subagent runs under its sidebar row; runs idle past 30 min sit behind "Show N idle". Child sessions stay separate rows. */
export function SubagentRuns({ runs = [], now, open }) {
  const [showIdle, setShowIdle] = useState(false);
  const { shown, idle } = splitIdleRuns(runs.filter(run => !run.child), now);
  if (!shown.length && !idle.length) return null;
  const item = run => <li key={run.id} className="flex min-w-0 items-center gap-1.5 text-xs">
    <button type="button" aria-label={"Open subagent " + (run.kind || "agent")} onClick={() => open(run)}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-0.5 text-left hover:bg-sidebar-accent">
      {runState(run, now) === "running" && <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground"/>}
      <span className="min-w-0 truncate">{run.kind || "agent"} · {run.steps} {run.steps === 1 ? "step" : "steps"}{run.description && " · " + run.description}</span>
    </button>
  </li>;
  return <ul aria-label="Subagents" className="ml-8 flex flex-col gap-0.5 border-l pl-2">
    {shown.map(item)}
    {idle.length > 0 && <li><button type="button" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)}
      className="px-1 text-xs text-muted-foreground underline-offset-2 hover:underline">{showIdle ? "Hide idle" : "Show " + idle.length + " idle"}</button></li>}
    {showIdle && idle.map(item)}
  </ul>;
}
