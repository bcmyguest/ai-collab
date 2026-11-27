import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "./chat-api";

const CHECK_LABEL = { success: "Checks green", pending: "Checks pending", failure: "Checks failing", none: "No checks" };

/** Open PRs into main. state is null while loading, else {prs, deploy, error}; Merge needs green checks. */
export function LandPanel({ state, busy, result, onMerge }) {
  if (!state) return <section aria-label="Land" className="space-y-2"><p role="status" className="text-sm">Loading open PRs…</p></section>;
  return <section aria-label="Land" className="space-y-3">
    {state.error && <p role="alert" className="text-sm break-words">{state.error}</p>}
    {state.prs?.length === 0 && <p className="text-sm">No open PRs into main.</p>}
    {state.prs?.length > 0 && <ul className="space-y-3">{state.prs.map(pr =>
      <li key={pr.number} className="space-y-1 rounded-md border p-3">
        <a href={`${pr.url}/files`} className="font-medium break-words underline">#{pr.number} {pr.title}</a>
        <div className="text-sm break-all">{pr.branch}</div>
        <div className="text-sm">
          <span>+{pr.additions}</span> <span>-{pr.deletions}</span> · <span>{CHECK_LABEL[pr.checks]}</span>
        </div>
        <Button type="button" variant="outline" disabled={pr.checks !== "success" || busy}
          onClick={() => onMerge(pr)}>Merge</Button>
      </li>)}</ul>}
    <p role="status" className="text-sm break-words">{result}</p>
    {state.deploy && <p className="text-sm break-words">Deploy {state.deploy.at}: {state.deploy.line}</p>}
  </section>;
}

/** The banner every screen shows while `ai-collab deploy --from` serves a tree other than main. */
export function DeployedBanner({ deployed }) {
  if (!deployed) return null;
  return <p role="status" className="rounded-md border border-amber-500 bg-amber-500/15 px-3 py-1 text-sm font-medium break-all">deployed: {deployed}</p>;
}

/** The Land panel: loads /api/land and merges through POST /api/land with the same sign-in as approvals. */
export function Land() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/land");
      const body = await response.json();
      setState(response.ok ? body : { prs: [], error: body.error || "Could not list PRs" });
    } catch (error) {
      setState({ prs: [], error: error.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function merge(pr) {
    setBusy(true);
    setResult("");
    try {
      const body = await api("land", { number: pr.number, headSha: pr.headSha });
      setResult(`${body.status}: ${body.detail}`);
    } catch (error) {
      setResult(error.message);
    } finally {
      setBusy(false);
      load();
    }
  }
  return <LandPanel state={state} busy={busy} result={result} onMerge={merge} />;
}
