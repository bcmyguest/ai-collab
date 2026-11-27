import { useEffect, useState } from "react";
import { CalendarClock, SquareArrowOutUpRight } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { jobAgent, jobDetail, runLabel, runLink } from "@/lib/scheduled";

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

/** One run row: status, time and any error; a run whose command resumes a session opens that run's timeline. */
function RunRow({ run, link, open }) {
  const body = <span className="flex min-w-0 items-baseline gap-2">
    <span className="shrink-0 font-medium">{run.status}</span>
    <span className="min-w-0 truncate text-muted-foreground">{when(run.scheduledTime)}</span>
    {runLabel(run) && <span className="shrink-0 text-muted-foreground">{runLabel(run)}{run.finishedAt && Number.isSafeInteger(run.startedAt) ? " · " + Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000)) + "s" : ""}</span>}
    {link && <SquareArrowOutUpRight aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground"/>}
  </span>;
  return <li className="flex min-w-0 flex-col gap-0.5 rounded-lg border px-2 py-1.5">
    {link ? <a href={link} onClick={event => { event.preventDefault(); open(link); }}
      aria-label={run.status + " run at " + when(run.scheduledTime) + ", open its session timeline"}
      className="flex min-w-0 rounded-md text-xs underline-offset-2 hover:underline">{body}</a>
      : <span className="flex min-w-0 text-xs">{body}</span>}
    {run.error && <span className="break-words text-xs text-destructive">{run.error}</span>}
  </li>;
}

/** The job's recent tick rows, newest first: status, time and any error; a run links to its session timeline. */
function RunList({ runs, project, open }) {
  if (!runs) return <p className="text-xs text-muted-foreground">Loading runs…</p>;
  if (runs.error) return <p className="text-xs text-muted-foreground">{runs.error}</p>;
  if (!runs.length) return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  // Each run's window is clamped against its neighbours, so the runs link to different slices of one timeline.
  return <ul aria-label="Recent runs" className="flex flex-col gap-2">
    {runs.map(run => <RunRow key={run.id} run={run} link={runLink(run, project, runs)} open={open}/>)}
  </ul>;
}

/** The runner's schedules in the sidebar; each is a job, not an agent. A run opens its session timeline. */
export function ScheduledJobs({ project = "", openRun }) {
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
  async function show(name) {
    setOpen(name);
    if (runs[name]) return;
    const next = await getJson("/api/schedules?runs=" + encodeURIComponent(name));
    setRuns(prev => ({ ...prev, [name]: next.error ? { error: next.error } : next }));
  }
  const job = (list?.schedules || []).find(item => item.name === open);
  // A run link is the console's own hash: close the sheets and hand it to the console, which parses it like any hash.
  const openAt = hash => { setOpen(""); openRun?.(hash); };
  return <section aria-label="Scheduled jobs" className="px-2 pb-2">
    <h2 className="flex items-center gap-1.5 pb-2 text-xs font-medium text-muted-foreground"><CalendarClock className="size-3.5"/>Scheduled jobs</h2>
    {!list ? <p className="px-1 text-sm text-muted-foreground">Loading schedules…</p>
      : list.status !== "up" ? <p className="px-1 text-sm text-muted-foreground">runner offline</p>
      : <>
        {list.schedules?.length === 0 && <p className="px-1 text-sm text-muted-foreground">No schedules in schedules.json.</p>}
        <ul className="flex flex-col gap-1">
          {(list.schedules || []).map(item => <li key={item.name}>
            <button type="button" aria-haspopup="dialog" aria-label={"Schedule " + item.name} onClick={() => show(item.name)}
              className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent", open === item.name && "bg-sidebar-accent")}>
              <span className="truncate font-medium">{item.name} <span className="font-normal text-muted-foreground">· every {item.everyMs / 60_000} min</span></span>
              {item.command && <span className="truncate font-mono text-xs text-muted-foreground">{item.command.join(" ")}</span>}
              <span className="text-xs text-muted-foreground">last {item.last ? item.last.status + " " + when(item.last.scheduledTime) : "never"} · next {when(item.nextRun)}</span>
              {jobAgent(item) && <span className="truncate text-xs text-muted-foreground">resumes <span className="font-mono">{jobAgent(item)}</span></span>}
            </button>
          </li>)}
        </ul>
        {list.configError?.length > 0 && <p className="px-1 pt-1 text-xs text-primary">{list.configError.length} schedule entries skipped</p>}
      </>}
    <Sheet open={Boolean(job)} onOpenChange={next => { if (!next) setOpen(""); }}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        {job && <>
          <div className="px-4 pt-4"><SheetTitle>{job.name}</SheetTitle>
          <SheetDescription>Scheduled job, read-only</SheetDescription></div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 px-4 text-sm">
            {jobDetail(job).map(([label, value]) => <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{value}</dd>
            </div>)}
          </dl>
          <h3 className="px-4 pb-2 pt-4 text-xs font-medium text-muted-foreground">Recent runs</h3>
          <div className="px-4 pb-6"><RunList runs={runs[job.name]} project={project} open={openAt}/></div>
        </>}
      </SheetContent>
    </Sheet>
  </section>;
}
