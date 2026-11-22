import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toGraph } from "@/lib/pattern-graph";
import { renameTeam, sourceLine } from "@/lib/team-editor";
import { RoleGraph } from "./pattern-graph";

export const CHECK_MS = 300;

// DOT text with a live graph above it (one column on phones, side by side on desktop). Each edit is checked after CHECK_MS;
// while the text has an error the graph keeps the last valid one, and the error shows with its source line.
export function TeamEditor({ pattern, templates, project, call, go, disabled }) {
  const isNew = !pattern;
  const [templateName, setTemplateName] = useState(templates[0]?.name ?? "");
  const [name, setName] = useState(pattern?.name ?? "");
  const [text, setText] = useState(pattern ? pattern.dot ?? "" : renameTeam(templates[0]?.text ?? "", ""));
  const [check, setCheck] = useState(null);
  const [good, setGood] = useState(pattern ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      const result = await call({ project, team: name, checkDot: text });
      if (id !== latest.current) return;
      setCheck(result);
      if (result.ok) setGood(result.pattern);
    }, CHECK_MS);
    return () => clearTimeout(timer);
  }, [text, name, project]);

  const error = check && !check.ok ? check.error : "";
  const canSave = !disabled && !busy && Boolean(check?.ok) && Boolean(name);

  function pickTemplate(value) {
    const picked = templates.find(item => item.name === value);
    setTemplateName(value);
    if (picked) setText(renameTeam(picked.text, name));
  }

  function rename(value) {
    setName(value);
    setText(current => renameTeam(current, value));
  }

  async function save() {
    setBusy(true); setNotice("");
    const result = await call({ project, team: name, teamDot: text });
    setBusy(false);
    if (result?.error) { setNotice(result.error); return; }
    go({ pattern: result.name });
  }

  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-3 py-4 text-sm lg:flex-row lg:items-start">
    <section className="flex min-w-0 flex-col gap-2 lg:flex-1">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Graph</h2>
      <div className="rounded-xl border bg-card p-2">
        {good?.roles?.length ? <RoleGraph graph={toGraph(good)} label={`Graph of ${good.name}`}/>
          : <p className="py-8 text-center text-xs text-muted-foreground">No valid graph yet.</p>}
      </div>
      {error && good && <p className="text-xs text-muted-foreground">Showing the last valid graph.</p>}
    </section>

    <section className="flex min-w-0 flex-col gap-2 lg:flex-1">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Definition (team.dot)</h2>
      {isNew ? <div className="flex flex-wrap gap-2">
        <input aria-label="Team name" className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs" placeholder="team-name" maxLength={24} value={name} onChange={e => rename(e.target.value)}/>
        {templates.length > 0 && <select aria-label="Template" className="rounded border bg-background px-2 py-1 text-xs" value={templateName} onChange={e => pickTemplate(e.target.value)}>
          {templates.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>}
      </div> : <p className="font-mono text-xs">@{pattern.name} · saved as a project team file</p>}
      {error && <div role="alert" className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
        <p>{error}</p>
        {check.line && <code className="block overflow-x-auto font-mono">{sourceLine(text, check.line)}</code>}
      </div>}
      {!error && check?.ok && <p className="text-xs text-muted-foreground">Valid. Save writes {name}/team.dot in the project.</p>}
      <textarea aria-label="Team definition" spellCheck={false} rows={12} value={text} onChange={e => setText(e.target.value)}
        className="min-h-56 w-full rounded-xl border bg-background p-3 font-mono text-xs leading-relaxed"/>
      {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!canSave} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => go(isNew ? {} : { pattern: pattern.name })}>Cancel</Button>
      </div>
    </section>
  </div>;
}
