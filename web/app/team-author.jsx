import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toGraph } from "@/lib/pattern-graph";
import { initialChoice, modelsOf } from "@/lib/start-default";
import { ConfirmButton, RoleGraph } from "./pattern-graph";
import { renameTeam, sourceLine } from "@/lib/team-editor";

// The operator describes a team in words; a writing agent drafts team.dot; the operator confirms the name and saves.
// With `pattern` set it edits that team: the current DOT goes into the brief, and saving replaces it after a confirm.
// The DOT editor stays the escape hatch: "Open in DOT editor" carries the name there.
export function TeamAuthor({ templates, pattern = null, project, call, go, disabled, startable = [], models = {}, authorDefault = { harness: "cursor", model: "deepseek-v41-flash-1017-high" } }) {
  const editing = Boolean(pattern);
  const [request, setRequest] = useState("");
  const [name, setName] = useState(pattern?.name ?? "");
  const [scope, setScope] = useState(pattern?.source === "global" ? "global" : "project");
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState(null);
  const [writer, setWriter] = useState(() => initialChoice({ startable, models, setting: authorDefault }));
  const pickedWriter = useRef(false);
  // Set when a save was refused because the name is taken; the save becomes an explicit Replace.
  const [replaceAsk, setReplaceAsk] = useState(false);

  const canAsk = !disabled && !busy && request.trim().length > 0;
  const checked = draft?.ok === true;
  // The name to save under: what the operator typed, else the team being refined, else the digraph the agent wrote.
  const target = name || pattern?.name || draft?.name || draft?.suggested || "";
  // The draft says which entry already uses the name it was checked under; that only applies while that is still the
  // name being saved. A name typed afterwards is checked by the save, which offers Replace when it is taken.
  const replaces = checked && draft.exists && draft.exists !== "built-in" && draft.exists !== "team" && target === draft.name;
  const harnesses = startable.length ? startable : (writer.harness ? [writer.harness] : []);
  const listedModels = modelsOf(models, writer.harness);
  const modelChoices = listedModels.includes(writer.model) || !writer.model ? listedModels : [writer.model, ...listedModels];

  useEffect(() => {
    if (pickedWriter.current) return;
    setWriter(initialChoice({ startable, models, setting: authorDefault }));
  }, [startable, models, authorDefault]);

  async function ask() {
    setBusy("draft"); setNotice("");
    // Editing: the team as it is now is the base; once a valid draft exists, the newest draft takes its place.
    const current = draft?.ok ? draft.dot : editing ? pattern.dot ?? "" : "";
    // The operator's words carry the conversation; a valid draft is already in `current`, so its answer is not repeated.
    // When the last answer did not check, it is carried as a turn instead, so the writer can see what it wrote wrong.
    const said = history.filter(turn => turn.from === "operator" || !current);
    const result = await call({
      project, authorRequest: request, team: name || pattern?.name || "", authorScope: scope, authorTurns: said, authorCurrent: current,
      ...(writer.harness ? { authorHarness: writer.harness, authorModel: writer.model } : {}),
    });
    setBusy("");
    if (result?.error) { setNotice(result.error); return; }
    setHistory(turns => [...turns, { from: "operator", text: request }, ...(result.reply ? [{ from: "agent", text: result.reply }] : [])]);
    if (result.status === "failed") { setNotice(result.detail || "The writing agent failed."); return; }
    setDraft(result);
    setReplaceAsk(false);
    if (!result.ok) setNotice(result.error);
  }

  const graph = checked ? toGraph(draft.pattern) : null;
  // The name the DOT declares; a name typed after the draft renames the digraph, exactly as the DOT editor does.
  const declared = draft?.suggested || draft?.name || "";
  const dotText = checked && declared && target && declared !== target ? renameTeam(draft.dot, target) : draft?.dot ?? "";

  async function save() {
    if (!target) { setNotice("Give the team a name to save it."); return; }
    setBusy("save"); setNotice("");
    const result = await call({ project, team: target, authorScope: scope, authorDot: dotText, authorReplace: replaces || replaceAsk ? target : "" });
    setBusy("");
    if (result?.error) {
      // A name typed after the draft can already be in use; that is the operator's call to replace, so offer it rather than fail.
      if (replaces || replaceAsk || !/already exists/.test(result.error)) { setNotice(result.error); return; }
      setReplaceAsk(true); setNotice(result.error); return;
    }
    go({ pattern: result.name });
  }
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 text-sm">
    <div className="flex flex-col gap-1">
      <h2 className="font-semibold">{editing ? `Refine ${pattern.name}` : "Describe a team"}</h2>
      <p className="text-xs text-muted-foreground">{editing
        ? "Say what should change. The agent sees the team as it is now, drafts the whole file, and nothing is saved until you approve."
        : "Say what the team should do, in your own words. Pick the agent and model that draft team.dot, confirm, and it is saved. No DOT unless you want it."}</p>
    </div>

    <section className="flex flex-col gap-2">
      <label className="text-xs font-medium" htmlFor="author-request">{editing ? "What should change?" : "What should the team do?"}</label>
      <textarea id="author-request" rows={4} value={request} disabled={disabled || Boolean(busy)} onChange={event => setRequest(event.target.value)}
        placeholder={editing ? "Add a reviewer after the tests pass, and let it send the work back twice." : "One agent scopes a small change, a second implements it with tests, a third reviews and can send it back twice."}
        className="min-h-24 w-full rounded-xl border bg-background p-3 text-sm leading-relaxed"/>
      <div className="flex flex-wrap gap-2">
        {editing
          ? <span className="rounded border bg-muted/40 px-2 py-1 font-mono text-xs">{pattern.name} · {scope}</span>
          : <input aria-label="Team name" placeholder="team-name (optional; the agent can propose one)" maxLength={24} value={name} disabled={disabled || Boolean(busy)}
            onChange={event => { setName(event.target.value); setReplaceAsk(false); }} className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs"/>}
        {!editing && <select aria-label="Scope" className="rounded border bg-background px-2 py-1 text-xs" value={scope} disabled={disabled || Boolean(busy)} onChange={event => setScope(event.target.value)}>
          <option value="project">project</option>
          <option value="global">global</option>
        </select>}
        {harnesses.length > 0 && <select aria-label="Writing agent" className="rounded border bg-background px-2 py-1 text-xs" value={writer.harness} disabled={disabled || Boolean(busy)} onChange={event => {
          const harness = event.target.value;
          pickedWriter.current = true;
          setWriter({ harness, model: modelsOf(models, harness)[0] || "" });
        }}>
          {harnesses.map(harness => <option key={harness} value={harness}>{harness}</option>)}
        </select>}
        {modelChoices.length > 0 && <select aria-label="Writing model" className="max-w-full rounded border bg-background px-2 py-1 font-mono text-xs" value={writer.model} disabled={disabled || Boolean(busy)} onChange={event => { pickedWriter.current = true; setWriter(current => ({ ...current, model: event.target.value })); }}>
          {modelChoices.map(model => <option key={model} value={model}>{model}</option>)}
        </select>}
        <Button type="button" size="sm" disabled={!canAsk} onClick={ask}>{busy === "draft" ? "Drafting…" : history.length ? "Ask again" : "Draft with agent"}</Button>
      </div>
      {history.length > 0 && <p className="text-xs text-muted-foreground">{history.length} message{history.length === 1 ? "" : "s"} so far; the agent sees them, so you can refine in words.</p>}
    </section>

    {notice && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
      {notice}
      {draft?.line && <code className="mt-1 block overflow-x-auto font-mono">{sourceLine(draft.dot ?? "", draft.line)}</code>}
    </p>}

    {checked && <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Draft</h3>
      <div className="rounded-xl bg-card shadow-surface p-2"><RoleGraph graph={graph} label={`Draft graph of ${draft.pattern.name}`}/></div>
      <ul className="flex flex-col gap-1 text-xs">
        {draft.pattern.roles.map(role => <li key={role.id} className="flex flex-wrap gap-2 rounded-lg border px-2 py-1.5">
          <span className="font-mono font-semibold">{role.id}</span>
          <span className="font-mono text-muted-foreground">{[role.harness, role.model].filter(Boolean).join(" · ")}</span>
          <span className="text-muted-foreground">{role.responsibility}</span>
        </li>)}
      </ul>
      <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{dotText}</pre>
      {draft.warnings?.length > 0 && <p className="text-xs text-muted-foreground">Ignored: {draft.warnings.map(item => `${item.message}`).join("; ")}</p>}
      <p className="text-xs text-muted-foreground">Saves <span className="font-mono">{target}/team.dot</span>{scope === "global" ? " in the global teams folder" : " in this project"}{replaces ? ". This name is in use, so saving replaces it." : "."}</p>
      <div className="flex flex-wrap gap-2">
        {replaces || replaceAsk
          ? <ConfirmButton label="Replace and save" question={`Replace the existing team ${target}?`} confirmLabel="Replace" disabled={disabled || Boolean(busy)} onConfirm={save}/>
          : <Button type="button" size="sm" disabled={disabled || Boolean(busy) || !target} onClick={save}>{busy === "save" ? "Saving…" : "Save team"}</Button>}
        <Button type="button" size="sm" variant="outline" disabled={disabled || Boolean(busy)} onClick={() => go({ edit: editing ? "1" : "new", ...(editing ? { pattern: pattern.name } : { authorName: target }) })}>Open in DOT editor</Button>
        <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => { setDraft(null); setNotice(""); }}>Discard draft</Button>
      </div>
      {!name && !editing && draft?.suggested && <p className="text-xs text-muted-foreground">The agent named it <span className="font-mono">{draft.suggested}</span>; type another name above to save it elsewhere.</p>}
    </section>}

    {!editing && templates.length > 0 && <p className="text-xs text-muted-foreground">Prefer a starting point? <button type="button" className="underline underline-offset-2" onClick={() => go({ edit: "new" })}>Start from a template</button>.</p>}
  </div>;
}
