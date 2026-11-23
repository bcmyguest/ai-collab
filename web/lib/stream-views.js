import { createMemory } from "./view-memory.js";

// Screens kept warm, newest use first: switching back and forth between them never waits for the server.
const RECENT_STREAMS = 6;
export const ACTIVITY_MAX = 500;

/** One ACTIVITY_BATCH: a reset replaces the rows, an append follows them, and the newest ACTIVITY_MAX stay. */
export function mergeActivity(activity, { reset, items }) {
  return (reset ? items : [...activity, ...items]).slice(-ACTIVITY_MAX);
}

/**
 * The last view of each recent /api/events stream: its state snapshot, activity rows and A2UI surfaces. A screen
 * switched back to renders this at once, then its reconnected stream replaces it with the current state.
 */
export function createStreamViews(limit = RECENT_STREAMS) {
  const memory = createMemory(limit);
  // Reading a view makes it the most recent, so a screen the operator keeps returning to is never the one dropped.
  const remember = key => {
    const view = memory.get(key);
    if (view !== undefined) memory.set(key, view);
    return view;
  };
  return {
    restore: remember,
    /**
     * The reducer for one stream's frames, returning the view to render. Frames update the cached view in place, so
     * surfaces go before each state frame, a full activity reset follows it, and a reconnect never blanks a screen.
     * A frame that arrives before this screen's first state snapshot has no view to render, so it only caches.
     */
    connect(key) {
      let view = remember(key);
      return (event, data) => {
        if (event === "state") view = { ...view, data };
        else if (event === "surface") view = { ...view, surfaces: { ...view?.surfaces, [data.id]: data.operations } };
        else if (event === "activity") view = { ...view, activity: mergeActivity(view?.activity ?? [], data) };
        else return undefined;
        if (!view?.data) return undefined;
        const stored = { data: view.data, activity: view.activity ?? [], surfaces: view.surfaces ?? {} };
        memory.set(key, stored);
        return stored;
      };
    },
  };
}

export const streamViews = createStreamViews();
