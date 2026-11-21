// In-memory view state that outlives a remount: composer drafts per conversation, Home's scroll and expanded groups.
export const MEMORY_MAX = 200;

/** One conversation's draft key: project chat and activity share project + "", a session's views share its address. */
export function conversationKey(project, session = "") {
  return JSON.stringify([project || "", session || ""]);
}

/** A bounded Map: setting an empty value deletes it, and the oldest key drops past max. */
export function createMemory(max = MEMORY_MAX) {
  const map = new Map();
  return {
    get: (key, fallback) => map.has(key) ? map.get(key) : fallback,
    set(key, value) {
      map.delete(key);
      if (value === undefined || value === "") return;
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value);
    },
    delete: key => map.delete(key),
    get size() { return map.size; },
  };
}

export const drafts = createMemory();
export const views = createMemory();
