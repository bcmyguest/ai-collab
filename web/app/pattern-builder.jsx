import { useState } from "react";
import { Button } from "@/components/ui/button";

const DONE = "done";

// The shipped "fix-and-review" pattern as an editable starting point; mirrors BUILT_IN_PATTERNS in lib/patterns.mjs.
const TEMPLATE = {
  name: "fix-and-review",
  roles: [
    { id: "lead", responsibility: "Scope the task into one change with acceptance criteria. Hand off to the implementer.", harness: "claude", model: "claude-haiku-5-5" },
    { id: "implementer", responsibility: "Edit the code and add or run tests. Hand off the diff and test results to the reviewer.", harness: "claude", model: "claude-haiku-5-5" },
    { id: "reviewer", responsibility: "Review the diff against the scope. Approve, or request changes with specific points.", harness: "cursor", model: "deepseek-v41-flash-1017-high" },
  ],
  handoffs: [
    { from: "lead", to: "implementer", on: "scope", required: false, cap: "" },
    { from: "implementer", to: "reviewer", on: "diff and test results", required: true, cap: "" },
    { from: "reviewer", to: "implementer", on: "changes requested", required: false, cap: "3" },
    { from: "reviewer", to: "lead", on: "approved", required: true, cap: "" },
    { from: "lead", to: DONE, on: "finished", required: false, cap: "" },
  ],
};

function starterState() {
  return {
    name: TEMPLATE.name,
    roles: TEMPLATE.roles.map(role => ({ ...role })),
    handoffs: TEMPLATE.handoffs.map(handoff => ({ ...handoff })),
  };
}

function payloadOf(state) {
  const roles = state.roles.map(role => ({
    id: role.id.trim(), responsibility: role.responsibility.trim(), harness: role.harness,
    ...(role.model.trim() ? { model: role.model.trim() } : {}),
  }));
  const handoffs = state.handoffs.map(handoff => ({
    from: handoff.from, to: handoff.to, on: handoff.on.trim(), required: handoff.required,
    ...(handoff.cap !== "" && handoff.to !== DONE ? { cap: Number(handoff.cap) } : {}),
  }));
  return { name: state.name.trim(), roles, handoffs };
}

// One line per handoff: from -> to, the event that triggers it, and whether the run enforces it.
export function HandoffDiagram({ handoffs }) {
  return <ol className="flex flex-col gap-1 font-mono text-xs">
    {handoffs.map((handoff, index) => <li key={index} className="flex flex-wrap items-center gap-1">
      <span className="rounded border px-1">{handoff.from}</span>
      <span>→</span>
      <span className="rounded border px-1">{handoff.to}</span>
      <span className="text-muted-foreground">&quot;{handoff.on}&quot;</span>
      <span className={handoff.required ? "text-foreground" : "text-muted-foreground"}>
        {handoff.required ? "required" : "guidance"}{handoff.cap !== "" && handoff.cap !== undefined ? ` · max ${handoff.cap}` : ""}
      </span>
    </li>)}
  </ol>;
}

export function PatternBuilder({ project, startable, disabled, create, close }) {
  const [state, setState] = useState(starterState);
  const [error, setError] = useState("");
  const roleIds = state.roles.map(role => role.id.trim()).filter(Boolean);
  const targets = [...roleIds, DONE];
  const patch = (key, index, values) => setState(prev => ({ ...prev, [key]: prev[key].map((item, i) => (i === index ? { ...item, ...values } : item)) }));
  const remove = (key, index) => setState(prev => ({ ...prev, [key]: prev[key].filter((_, i) => i !== index) }));
  // A renamed role keeps its handoffs: every from and to that named the old id takes the new one.
  const renameRole = (index, next) => setState(prev => {
    const old = prev.roles[index].id;
    return {
      ...prev,
      roles: prev.roles.map((role, i) => (i === index ? { ...role, id: next } : role)),
      handoffs: prev.handoffs.map(handoff => ({
        ...handoff,
        from: handoff.from === old ? next : handoff.from,
        to: handoff.to === old ? next : handoff.to,
      })),
    };
  });
  const add = (key, item) => setState(prev => ({ ...prev, [key]: [...prev[key], item] }));

  async function save() {
    setError("");
    const payload = payloadOf(state);
    if (!payload.name) { setError("Name the pattern"); return; }
    const result = await create({ project, pattern: payload });
    if (result?.error) { setError(result.error); return; }
    close();
  }

  return <div className="flex w-full flex-col gap-3 rounded-xl border bg-card p-3 text-sm shadow-sm">
    <div className="flex items-center justify-between gap-2">
      <span className="font-medium">Create pattern</span>
      <Button type="button" variant="ghost" size="sm" onClick={close}>Cancel</Button>
    </div>
    <input className="rounded-lg border bg-background px-2 py-1.5 font-mono text-xs" placeholder="fix-and-review" value={state.name}
      onChange={e => setState(prev => ({ ...prev, name: e.target.value }))}/>

    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Roles</span>
      {state.roles.map((role, index) => <div key={index} className="flex flex-col gap-1 rounded-lg border p-2">
        <div className="flex flex-wrap gap-1">
          <input className="w-28 rounded border bg-background px-1.5 py-1 font-mono text-xs" placeholder="role" value={role.id}
            onChange={e => renameRole(index, e.target.value)}/>
          <select className="rounded border bg-background px-1 py-1 text-xs" value={role.harness} onChange={e => patch("roles", index, { harness: e.target.value })}>
            {startable.map(harness => <option key={harness} value={harness}>{harness}</option>)}
          </select>
          <input className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 font-mono text-xs" placeholder="model (optional)" value={role.model}
            onChange={e => patch("roles", index, { model: e.target.value })}/>
          <Button type="button" variant="ghost" size="sm" disabled={state.roles.length < 2} onClick={() => remove("roles", index)}>Remove</Button>
        </div>
        <textarea className="min-h-[3rem] rounded border bg-background px-1.5 py-1 text-xs" placeholder="responsibility" value={role.responsibility}
          onChange={e => patch("roles", index, { responsibility: e.target.value })}/>
      </div>)}
      <Button type="button" variant="ghost" size="sm" disabled={state.roles.length >= 8}
        onClick={() => add("roles", { id: "", responsibility: "", harness: startable[0] || "", model: "" })}>Add role</Button>
    </div>

    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Handoffs</span>
      {state.handoffs.map((handoff, index) => <div key={index} className="flex flex-wrap items-center gap-1 rounded-lg border p-2 text-xs">
        <select className="rounded border bg-background px-1 py-1" value={handoff.from} onChange={e => patch("handoffs", index, { from: e.target.value })}>
          {roleIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <span>→</span>
        <select className="rounded border bg-background px-1 py-1" value={handoff.to} onChange={e => patch("handoffs", index, { to: e.target.value })}>
          {targets.filter(id => id !== handoff.from).map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <input className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 font-mono" placeholder="event, e.g. approved" value={handoff.on}
          onChange={e => patch("handoffs", index, { on: e.target.value })}/>
        <Button type="button" variant="outline" size="sm" onClick={() => patch("handoffs", index, { required: !handoff.required })}>
          {handoff.required ? "required" : "guidance"}
        </Button>
        {handoff.to !== DONE && <input className="w-14 rounded border bg-background px-1.5 py-1 font-mono" placeholder="cap" inputMode="numeric" value={handoff.cap}
          onChange={e => patch("handoffs", index, { cap: e.target.value.replace(/\D/g, "") })}/>}
        <Button type="button" variant="ghost" size="sm" onClick={() => remove("handoffs", index)}>Remove</Button>
      </div>)}
      <Button type="button" variant="ghost" size="sm" disabled={roleIds.length < 1}
        onClick={() => add("handoffs", { from: roleIds[0] || "", to: DONE, on: "", required: false, cap: "" })}>Add handoff</Button>
    </div>

    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">Diagram</span>
      <HandoffDiagram handoffs={state.handoffs.map(handoff => ({ ...handoff, on: handoff.on || "…" }))}/>
    </div>

    {error && <p className="text-xs text-destructive">{error}</p>}
    <Button type="button" size="sm" disabled={disabled} onClick={save}>Save pattern</Button>
  </div>;
}

// Runs for the project: status, the active role, and the handoff log.
export function PatternRuns({ runs }) {
  if (!runs?.length) return null;
  return <ul className="flex flex-col gap-2 text-xs">
    {runs.map(run => <li key={run.id} className="rounded-lg border p-2">
      <div className="flex justify-between gap-2 font-mono">
        <span className="truncate">{run.pattern}</span>
        <span className="shrink-0 text-muted-foreground">{run.status}</span>
      </div>
      <div className="text-muted-foreground">active: <span className="font-mono">{run.active}</span>{run.error ? ` · ${run.error}` : ""}</div>
      <ol className="mt-1 flex flex-col gap-0.5 font-mono">
        {(run.handoffs || []).map(handoff => <li key={handoff.seq}>{handoff.seq}. {handoff.from} → {handoff.to} &quot;{handoff.on}&quot;{handoff.note ? ` — ${handoff.note}` : ""}</li>)}
      </ol>
    </li>)}
  </ul>;
}
