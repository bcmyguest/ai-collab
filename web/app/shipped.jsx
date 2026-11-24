"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

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

export function Shipped({ items, open }) {
  const [seen, setSeen] = useState(readCheckIn);
  useEffect(() => {
    const sync = event => {
      if (event.key === storageKey || event.key === null) setSeen(readCheckIn());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const unseen = items.filter(item => !seen.has(shipmentKey(item)));
  if (!unseen.length) return null;

  function checkIn() {
    const next = new Set([...readCheckIn(), ...seen, ...unseen.map(shipmentKey)]);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch {}
    setSeen(next);
  }

  return <section aria-labelledby="shipped-heading" className="rounded-xl border bg-card p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="shipped-heading" className="text-sm font-medium">Shipped since last check · {unseen.length}</h2>
      <Button size="sm" variant="outline" onClick={checkIn}>Mark all seen</Button>
    </div>
    <ul className="mt-2 divide-y">
      {unseen.map(item => <li key={shipmentKey(item)}>
        <button type="button" onClick={() => open(item)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 rounded-md px-1 text-left text-sm hover:bg-accent">
          <span className="min-w-0 break-words">{item.title}</span>
          <span className="text-xs text-muted-foreground">{item.project} · {item.commit.slice(0, 8)}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}
