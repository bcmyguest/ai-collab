import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toDot, toGraph } from "@/lib/pattern-graph";
import { SCOPE_LABELS, canCopy, canDelete, handoffLine, firedCounts, pendingEvents, runsOf } from "@/lib/pattern-view";
import { ConfirmButton, HandoffDiagram, RoleGraph } from "./pattern-graph";

const clock = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Tag({ children, tone = "" }) {
  return <span className={cn("shrink-0 rounded border px-1.5 text-[11px] font-medium", tone || "text-muted-foreground")}>{children}</span>;
}

function describe(pattern) {
  if (pattern.legacy) return `team · ${pattern.roles.length} member${pattern.roles.length === 1 ? "" : "s"}, no handoffs`;
  return pattern.description || "No description yet.";
}

function shortAddress(address) {
  return address ? address.replace(/#[a-f0-9]{6}[a-f0-9]*$/, "#…") : "not started";
}

function RunRow({ run, open }) {
  return <li>
    <button type="button" onClick={() => open(run)} className="flex w-full flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent">
      <span className="flex justify-between gap-2 font-mono">
        <span className="truncate">{run.pattern}</span>
        <span className={cn("shrink-0", run.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{run.status}</span>
      </span>
      <span className="text-muted-foreground">active {run.active} · {run.handoffs?.length ?? 0} handoffs · {clock.format(new Date(run.startedAt ?? 0))}</span>
    </button>
  </li>;
}

function PatternInspect({ pattern, own, go, act, busy, disabled, notice, raw }) {
  const graph = toGraph(pattern);
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="min-w-0 truncate font-mono text-base font-semibold">@{pattern.name}</h2>
      <Tag>{SCOPE_LABELS[pattern.source] ?? pattern.source}</Tag>
      {pattern.invalid && <Tag tone="border-destructive text-destructive">invalid</Tag>}
    </div>
    <p className="text-muted-foreground">{describe(pattern)}</p>
    {pattern.invalid && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{pattern.invalid}</p>}
    {canCopy(pattern.source) && <p className="text-xs text-muted-foreground">Read-only. Copy it to the project to change it.</p>}
    {pattern.source === "team" && !pattern.removable && <p className="text-xs text-muted-foreground">Global team: remove it from teams.json.</p>}

    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Roles</h3>
      <ul className="flex flex-col gap-1.5">
        {pattern.roles.map(role => <li key={role.id} className="rounded-lg border p-2 text-xs">
          <div className="flex flex-wrap gap-2 font-mono"><span className="font-semibold">{role.id}</span><span className="text-muted-foreground">{[role.harness, role.model].filter(Boolean).join(" · ")}</span></div>
          <p className="mt-1 text-muted-foreground">{role.responsibility || "No responsibility."}</p>
        </li>)}
      </ul>
    </section>

    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Graph</h3>
      <div className="rounded-xl border bg-card p-2"><RoleGraph graph={graph} label={`Graph of ${pattern.name}`}/></div>
      {pattern.handoffs.length ? <HandoffDiagram handoffs={pattern.handoffs}/> : <p className="text-xs text-muted-foreground">No handoffs. A team starts its members directly.</p>}
    </section>

    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Definition</h3>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant={raw ? "outline" : "default"} onClick={() => go({ pattern: pattern.name })}>Graph</Button>
        <Button type="button" size="sm" variant={raw ? "default" : "outline"} onClick={() => go({ pattern: pattern.name, raw: "1" })}>Raw</Button>
      </div>
      {raw && <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{toDot(graph, pattern.name)}</pre>}
    </section>

    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Runs</h3>
      {own.length ? <ul className="flex flex-col gap-1.5">{own.map(run => <RunRow key={run.id} run={run} open={item => go({ run: item.id })}/>)}</ul>
        : <p className="text-xs text-muted-foreground">No runs of this pattern yet.</p>}
    </section>

    {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      {canCopy(pattern.source) && <Button type="button" size="sm" disabled={disabled || Boolean(busy)} onClick={() => act("copy", { copyPattern: pattern.name }, () => go({ pattern: pattern.name }))}>
        Copy to project</Button>}
      {canDelete(pattern) && <ConfirmButton label="Delete" question={`Delete ${pattern.legacy ? "team" : "pattern"} ${pattern.name}?`} confirmLabel="Delete" disabled={disabled || Boolean(busy)}
        onConfirm={() => act("delete", { deletePattern: pattern.name }, () => go({}))}/>}
    </div>
  </div>;
}

export function PatternsPage({ data, project, selected, navigate, call, disabled }) {
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const patterns = [...(data.patterns ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const runs = data.runs ?? [];
  const go = next => navigate({ project, level: "patterns", ...next });
  // A notice or a pending action belongs to the view it began in; moving to another pattern or run clears both.
  const view = selected.run || selected.pattern || "";
  useEffect(() => { setNotice(""); setBusy(""); }, [view]);

  async function act(label, payload, after) {
    setBusy(label); setNotice("");
    const result = await call({ project, ...payload });
    setBusy("");
    if (result?.error) { setNotice(result.error); return; }
    after?.(result);
  }

  if (selected.run) {
    const run = runs.find(item => item.id === selected.run);
    if (!run) return <p className="py-16 text-center text-sm text-muted-foreground">Run {selected.run} is not in the last 20 runs.</p>;
    // Keyed on the handoff count so the operator's chosen event resets after each advance.
    return <RunView key={run.id + ":" + (run.handoffs?.length ?? 0)} run={run} data={data} go={go} act={act} busy={busy} disabled={disabled} notice={notice}/>;
  }

  if (selected.pattern) {
    const pattern = patterns.find(item => item.name === selected.pattern);
    if (!pattern) return <p className="py-16 text-center text-sm text-muted-foreground">Unknown pattern &quot;{selected.pattern}&quot;.</p>;
    return <PatternInspect pattern={pattern} own={runsOf(runs, pattern.name)} go={go} act={act} busy={busy} disabled={disabled} notice={notice} raw={selected.raw}/>;
  }

  const projectCount = patterns.filter(item => !item.legacy).length;
  const running = runs.filter(run => run.status === "running").length;
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 text-sm">
    <p className="text-xs text-muted-foreground">{projectCount} patterns · {patterns.length - projectCount} teams · {running} running</p>
    {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
    {!patterns.length && <p className="py-8 text-center text-muted-foreground">No patterns or teams yet.</p>}
    <ul className="flex flex-col gap-1.5">
      {patterns.map(pattern => <li key={pattern.name}>
        <button type="button" onClick={() => go({ pattern: pattern.name })} className="flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left hover:bg-sidebar-accent">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-mono font-medium">@{pattern.name}</span>
            <Tag>{SCOPE_LABELS[pattern.source] ?? pattern.source}</Tag>
            {pattern.invalid && <Tag tone="border-destructive text-destructive">invalid</Tag>}
          </span>
          <span className={cn("truncate text-xs", pattern.description || pattern.legacy ? "text-muted-foreground" : "italic text-muted-foreground/70")}>{describe(pattern)}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{pattern.roles.map(role => role.id).join(" → ")}</span>
        </button>
      </li>)}
    </ul>
    {runs.length > 0 && <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Recent runs</h2>
      <ul className="flex flex-col gap-1.5">{runs.map(run => <RunRow key={run.id} run={run} open={item => go({ run: item.id })}/>)}</ul>
    </section>}
  </div>;
}

function RunView({ run, data, go, act, busy, disabled, notice }) {
  const definition = run.definition ?? { roles: [], handoffs: [] };
  const events = pendingEvents(run);
  const [event, setEvent] = useState(events[0] ?? "");
  const [note, setNote] = useState("");
  const active = definition.roles.find(role => role.id === run.active);
  const fired = firedCounts(run);
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 text-sm">
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">Run {run.id} · <button type="button" className="underline-offset-2 hover:underline" onClick={() => go({ pattern: run.pattern })}>@{run.pattern}</button></p>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{run.status}</h2>
        <span className="text-xs text-muted-foreground">active {run.active}{active?.harness ? ` · ${active.harness}` : ""}</span>
      </div>
      <p className="text-xs">{run.task}</p>
      {run.error && <p role="alert" className="text-xs text-destructive">{run.error}</p>}
    </div>

    <div className="rounded-xl border bg-card p-2"><RoleGraph graph={toGraph(definition)} active={run.status === "running" ? run.active : ""} used={run} label={`Run ${run.id} graph`}/></div>

    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Roles</h3>
      <ul className="flex flex-col gap-1.5 text-xs">
        {definition.roles.map(role => {
          const address = run.sessions?.[role.id] ?? "";
          const agent = data.agents?.find(item => item.id === address);
          const entered = (run.handoffs ?? []).filter(handoff => handoff.to === role.id).length;
          return <li key={role.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5">
            <span className="font-mono font-semibold">{role.id}</span>
            {run.active === role.id && run.status === "running" && <Tag tone="border-primary text-primary">active</Tag>}
            <span className="font-mono text-muted-foreground">{shortAddress(address)}</span>
            {address && <span className={agent?.online ? "text-emerald-600" : "text-muted-foreground"}>{agent?.online ? "online" : "offline"}</span>}
            <span className="ml-auto text-muted-foreground">entered {entered}</span>
          </li>;
        })}
      </ul>
      {definition.handoffs.some(handoff => handoff.cap !== undefined) && <ul className="flex flex-col gap-1 text-xs">
        {definition.handoffs.filter(handoff => handoff.cap !== undefined).map(handoff => <li key={handoff.on + handoff.from} className="flex flex-wrap justify-between gap-2 font-mono">
          <span>{handoff.from} → {handoff.to} &quot;{handoff.on}&quot;</span>
          <span className={fired(handoff) >= handoff.cap ? "text-destructive" : "text-muted-foreground"}>{fired(handoff)}/{handoff.cap}</span>
        </li>)}
      </ul>}
    </section>

    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Handoffs</h3>
      {run.handoffs?.length ? <ol className="flex flex-col gap-2 border-l pl-3 text-xs">
        {run.handoffs.map(handoff => <li key={handoff.seq} className="flex flex-col gap-0.5">
          <span className="font-mono">{handoffLine(handoff)}</span>
          <span className="text-muted-foreground">{clock.format(new Date(handoff.at ?? 0))}{handoff.note ? ` · ${handoff.note}` : ""}</span>
        </li>)}
      </ol> : <p className="text-xs text-muted-foreground">No handoffs yet.</p>}
    </section>

    {run.status === "running" && <section className="flex flex-col gap-2 rounded-xl border p-3">
      <h3 className="text-xs font-medium">Operator advance</h3>
      <p className="text-xs text-muted-foreground">Takes the active role&apos;s handoff without its session. The handoff is recorded with your login.</p>
      {events.length ? <div className="flex flex-wrap gap-2">
        <select aria-label="Event" className="rounded border bg-background px-2 py-1 text-xs" value={event} onChange={e => setEvent(e.target.value)}>
          {events.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <input aria-label="Note" className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs" placeholder="note (optional)" maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/>
        <ConfirmButton label="Advance" question={`Advance ${run.active} on "${event}"?`} confirmLabel="Advance" disabled={disabled || Boolean(busy)}
          onConfirm={() => act("advance", { advanceRun: run.id, advanceEvent: event, advanceNote: note }, () => go({ run: run.id }))}/>
      </div> : <p className="text-xs text-muted-foreground">No handoff leaves {run.active}.</p>}
    </section>}
    {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
  </div>;
}
