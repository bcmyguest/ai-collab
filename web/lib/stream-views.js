import { createMemory } from "./view-memory.js";

const RECENT_STREAMS = 6;
const ACTIVITY_MAX = 500;

export function createStreamViews(limit = RECENT_STREAMS) {
  const memory = createMemory(limit);
  return {
    restore(key) {
      const view = memory.get(key);
      if (view) memory.set(key, view);
      return view;
    },
    connect(key) {
      let state;
      let activity = memory.get(key)?.activity ?? [];
      let surfaces = {};
      return (event, data) => {
        if (event === "state") state = data;
        else if (event === "surface") surfaces = { ...surfaces, [data.id]: data.operations };
        else if (event === "activity") {
          activity = (data.reset ? data.items : [...activity, ...data.items]).slice(-ACTIVITY_MAX);
        } else return;

        // The server sends surfaces before state and a full activity reset after it.
        if (!state) return;
        const view = { data: state, activity, surfaces };
        memory.set(key, view);
        return view;
      };
    },
  };
}
