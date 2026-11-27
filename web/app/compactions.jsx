"use client";
import { Badge } from "@/components/ui/badge";
import { axisPercent, clearText, compactionText, headroom, mapAxis, modelText, tokenCount } from "@/lib/compaction-view";
import { Avatar, ago } from "./chat-shared";

const MARK = { auto: "bg-primary", manual: "bg-primary", failed: "bg-destructive", clear: "bg-sky-500", model: "bg-emerald-500" };

// The sentence for one history entry: a compaction, a clear or a model switch.
const textOf = entry => entry.kind === "clear" ? clearText(entry) : entry.kind === "model" ? modelText(entry) : compactionText(entry);
const markOf = entry => entry.kind === "compaction" ? (entry.phase === "failed" ? MARK.failed : MARK[entry.trigger] || "bg-muted-foreground") : MARK[entry.kind];
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
    entries: agent.history || [],
  }));
  const axis = mapAxis(rows.map(row => row.entries), now);
  return <section aria-label="Compaction map" className="flex w-full flex-col gap-3">
    <p className="text-xs text-muted-foreground">Headroom counts to the harness window. No harness reports its auto-compact point, so none is shown. Markers: amber auto, blue manual, red failed, sky clear, green model switch.</p>
    {rows.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">No agents in this project yet.</p>}
    {rows.map(({ agent, entries }) => <article key={agent.id} data-compaction-agent={agent.id} className="flex min-w-0 flex-col gap-2.5 rounded-2xl bg-card shadow-surface p-3 text-sm">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <Avatar address={agent.id} className="size-6 text-xs"/>
        <span className="min-w-0 truncate font-mono text-xs">{short(agent.id)}</span>
        <Badge variant="outline">{agent.peer}</Badge>
        {agent.model && <span className="min-w-0 truncate text-xs text-muted-foreground">{agent.model}</span>}
      </header>
      <p className="text-xs text-muted-foreground">{contextLine(agent)}</p>
      <div role="list" aria-label={`Compactions of ${short(agent.id)}`} className="relative h-6 rounded-md bg-muted">
        {entries.map(entry => <span key={entry.id} role="listitem" className="contents">
          <span role="img" aria-label={`${ago(entry.at, now)}: ${textOf(entry)}`} title={textOf(entry)}
            style={{ left: `${axisPercent(entry.at, axis.start, axis.end)}%` }}
            className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${markOf(entry)}`}/>
        </span>)}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground"><span>{ago(axis.start, now)}</span><span>now</span></div>
      {entries.length === 0 && <p className="text-xs text-muted-foreground">No compactions, clears or model switches in the activity kept in memory.</p>}
      {entries.length > 0 && <ul className="flex flex-col gap-1 text-xs">
        {entries.slice(-RECENT).reverse().map(entry => <li key={entry.id} className="flex min-w-0 flex-wrap gap-x-2">
          <span className="shrink-0 text-muted-foreground">{ago(entry.at, now)}</span>
          <span className="min-w-0 break-words">{textOf(entry)}</span>
        </li>)}
      </ul>}
    </article>)}
  </section>;
}
