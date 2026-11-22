"use client";
import { Badge } from "@/components/ui/badge";
import { axisPercent, compactionText, headroom, mapAxis, pairCompactions, tokenCount } from "@/lib/compaction-view";
import { Avatar, ago } from "./chat";

const MARK = { auto: "bg-amber-500", manual: "bg-primary", failed: "bg-destructive" };
const RECENT = 3;
const short = address => address?.includes("#") ? address.slice(0, address.indexOf("#") + 9) : address;

// Context against the window the harness reported; a harness that reports none shows the tokens only.
function contextLine({ context }) {
  if (!Number.isSafeInteger(context?.tokens)) return "No context reading yet";
  const left = headroom(context);
  if (!left) return `${tokenCount(context.tokens)} tokens · window not reported`;
  return `${tokenCount(context.tokens)} of ${tokenCount(left.window)} · ${tokenCount(left.left)} to window`;
}

/** Every agent's compactions on one time axis, with its context against the reported window. */
export function CompactionMap({ agents, now }) {
  const rows = agents.map(agent => ({
    agent,
    entries: pairCompactions((agent.compactions || []).map(compaction => ({ type: "compact", compaction }))).map(row => row.compaction),
  }));
  const axis = mapAxis(rows.map(row => row.entries), now);
  return <section aria-label="Compaction map" className="flex w-full flex-col gap-3">
    <p className="text-xs text-muted-foreground">Headroom counts to the harness window. No harness reports its auto-compact point, so none is shown.</p>
    {rows.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">No agents in this project yet.</p>}
    {rows.map(({ agent, entries }) => <article key={agent.id} data-compaction-agent={agent.id} className="flex min-w-0 flex-col gap-2.5 rounded-2xl border bg-card p-3 text-sm">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <Avatar address={agent.id} className="size-6 text-[9px]"/>
        <span className="min-w-0 truncate font-mono text-xs">{short(agent.id)}</span>
        <Badge variant="outline">{agent.peer}</Badge>
        {agent.model && <span className="min-w-0 truncate text-xs text-muted-foreground">{agent.model}</span>}
      </header>
      <p className="text-xs text-muted-foreground">{contextLine(agent)}</p>
      <div role="list" aria-label={`Compactions of ${short(agent.id)}`} className="relative h-6 rounded-full bg-muted">
        {entries.map(entry => <span key={entry.at} role="listitem" className="contents">
          <span role="img" aria-label={`${ago(entry.at, now)}: ${compactionText(entry)}`} title={compactionText(entry)}
            style={{ left: `${axisPercent(entry.at, axis.start, axis.end)}%` }}
            className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${MARK[entry.phase === "failed" ? "failed" : entry.trigger] || "bg-muted-foreground"}`}/>
        </span>)}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground"><span>{ago(axis.start, now)}</span><span>now</span></div>
      {entries.length === 0 && <p className="text-xs text-muted-foreground">No compactions in the activity kept in memory.</p>}
      {entries.length > 0 && <ul className="flex flex-col gap-1 text-xs">
        {entries.slice(-RECENT).reverse().map(entry => <li key={entry.at} className="flex min-w-0 flex-wrap gap-x-2">
          <span className="shrink-0 text-muted-foreground">{ago(entry.at, now)}</span>
          <span className="min-w-0 break-words">{compactionText(entry)}</span>
        </li>)}
      </ul>}
    </article>)}
  </section>;
}
