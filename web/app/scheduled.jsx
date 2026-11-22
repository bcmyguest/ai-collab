import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

const POLL_MS = 60_000;

const when = (value) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

async function getJson(path) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    return response.ok ? await response.json() : { status: "offline", error: "HTTP " + response.status };
  } catch {
    return { status: "offline" };
  }
}

/** One schedule's latest tick rows, newest first, after a tap. */
function RunList({ runs }) {
  if (!runs) return <p className="text-xs text-muted-foreground">Loading runs…</p>;
  if (runs.error) return <p className="text-xs text-muted-foreground">{runs.error}</p>;
  if (!runs.length) return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  return <ul aria-label="Recent runs" className="flex flex-col gap-1 text-xs">
    {runs.map(run => <li key={run.id} className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-medium">{run.status}</span>
      <span className="min-w-0 truncate text-muted-foreground">{when(run.scheduledTime)}{run.error ? " · " + run.error : ""}</span>
    </li>)}
  </ul>;
}

/** The runner's schedules in the sidebar: name, interval, command, last and next run; read-only. */
export function ScheduledJobs() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState("");
  const [runs, setRuns] = useState({});
  useEffect(() => {
    let alive = true;
    const load = async () => { const next = await getJson("/api/schedules"); if (alive) setList(next); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  async function toggle(name) {
    if (open === name) { setOpen(""); return; }
    setOpen(name);
    if (runs[name]) return;
    const next = await getJson("/api/schedules?runs=" + encodeURIComponent(name));
    setRuns(prev => ({ ...prev, [name]: next.error ? { error: next.error } : next }));
  }
  return <section aria-label="Scheduled jobs" className="px-2 pb-2">
    <h2 className="flex items-center gap-1.5 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"><CalendarClock className="size-3.5"/>Scheduled</h2>
    {!list ? <p className="px-1 text-sm text-muted-foreground">Loading schedules…</p>
      : list.status !== "up" ? <p className="px-1 text-sm text-muted-foreground">runner offline</p>
      : <>
        {list.schedules?.length === 0 && <p className="px-1 text-sm text-muted-foreground">No schedules in schedules.json.</p>}
        <ul className="flex flex-col gap-1">
          {(list.schedules || []).map(job => <li key={job.name} className="flex flex-col">
            <button type="button" aria-expanded={open === job.name} onClick={() => toggle(job.name)}
              className={cn("flex min-w-0 flex-col gap-0.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent", open === job.name && "bg-sidebar-accent")}>
              <span className="truncate font-medium">{job.name} <span className="font-normal text-muted-foreground">· every {job.everyMs / 60_000} min</span></span>
              {job.command && <span className="truncate font-mono text-[11px] text-muted-foreground">{job.command.join(" ")}</span>}
              <span className="text-[11px] text-muted-foreground">last {job.last ? job.last.status + " " + when(job.last.scheduledTime) : "never"} · next {when(job.nextRun)}</span>
            </button>
            {open === job.name && <div className="px-2 py-1"><RunList runs={runs[job.name]}/></div>}
          </li>)}
        </ul>
        {list.configError?.length > 0 && <p className="px-1 pt-1 text-xs text-amber-700 dark:text-amber-300">{list.configError.length} schedule entries skipped</p>}
      </>}
  </section>;
}
