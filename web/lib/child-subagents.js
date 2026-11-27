// Child sessions (started by another session) as subagent entries on their parent.

/** Child entries per parent id: each card whose parent is also in cards, with its address, harness, model, name, online and activity time (seconds). */
export function childRuns(cards) {
  const ids = new Set(cards.map(card => card.id));
  const out = new Map();
  for (const card of cards) {
    if (!card.parent || card.parent === card.id || !ids.has(card.parent)) continue;
    const time = Math.floor(Math.max(card.seenAt || 0, card.lastActivityAt || 0) / 1000);
    const entry = { id: card.id, agent: card.parent, run: card.id, kind: card.harness || card.peer, ...(card.model ? { model: card.model } : {}), description: card.name || card.folder || "", online: card.online === true, time, lastTime: time, child: true };
    if (!out.has(card.parent)) out.set(card.parent, []);
    out.get(card.parent).push(entry);
  }
  return out;
}
