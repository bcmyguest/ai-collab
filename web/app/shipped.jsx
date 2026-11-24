"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const buildCommit = process.env.AI_COLLAB_BUILD_COMMIT;
const buildSubject = process.env.AI_COLLAB_BUILD_SUBJECT;
const storageKey = "ai-collab:shipped-check-in";
const shipmentKey = ({ project, id, commit }) => JSON.stringify([project, id, commit]);

function readCheckIn() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

export function Shipped({ items = [], open }) {
  const [seen, setSeen] = useState(readCheckIn);
  useEffect(() => {
    const sync = event => {
      if (event.key === storageKey || event.key === null) setSeen(readCheckIn());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const unseen = items.filter(item => !seen.has(shipmentKey(item)));
  if (!unseen.length && !buildCommit) return null;

  function checkIn() {
    const next = new Set([...readCheckIn(), ...seen, ...unseen.map(shipmentKey)]);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch {}
    setSeen(next);
  }

  return <section aria-labelledby="shipped-heading" className="rounded-xl border bg-card p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="shipped-heading" className="text-sm font-medium">{unseen.length ? `Shipped since last check · ${unseen.length}` : "Deployment"}</h2>
      {unseen.length > 0 && <Button size="sm" variant="outline" onClick={checkIn}>Mark all seen</Button>}
    </div>
    {buildCommit && <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
      <span>Deployed commit</span><code title={buildCommit}>{buildCommit.slice(0, 8)}</code>
      {buildSubject && <span className="min-w-0 [overflow-wrap:anywhere]">{buildSubject}</span>}
    </p>}
    {unseen.length > 0 && <ul className="mt-2 divide-y">
      {unseen.map(item => <li key={shipmentKey(item)}>
        <button type="button" onClick={() => open(item)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 rounded-md px-1 text-left text-sm hover:bg-accent">
          <span className="min-w-0 break-words">{item.title}</span>
          <span className="text-xs text-muted-foreground">{item.project} · {item.commit.slice(0, 8)}</span>
        </button>
      </li>)}
    </ul>}
  </section>;
}
