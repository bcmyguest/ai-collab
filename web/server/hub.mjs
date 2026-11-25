import { openHistory } from "./history.mjs";
import { pollCached, streamEvents } from "../../lib/transport.mjs";

export const HISTORY_LIMIT = 500;
const MAX_TOPICS = 40;
const RESUBSCRIBE_MS = 50;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60_000;
const RATE_LIMIT_MS = 30_000;

// One bus streaming subscription shared by every browser: history is fetched once per topic, then kept live.
export function createHub(cfg, { keep = () => false } = {}) {
  const history = openHistory(cfg);
  const topics = new Map();
  const listeners = new Set();
  let latestTime = Math.floor(Date.now() / 1000);
  let stream = null;
  let timer = null;
  let retry = RETRY_MIN_MS;
  let closed = false;

  function add(topic, events, { replay = false } = {}) {
    const entry = topics.get(topic);
    if (closed) return [];
    if (!replay) events = history.add(topic, events);
    if (!entry?.loaded) return [];
    const added = [];
    for (const ev of events) {
      if (entry.ids.has(ev.id)) continue;
      added.push(ev);
      entry.ids.add(ev.id);
      entry.events.push(ev);
    }
    for (const ev of entry.events.splice(0, Math.max(0, entry.events.length - HISTORY_LIMIT))) entry.ids.delete(ev.id);
    if (added.length) for (const listener of listeners) listener(topic, added);
    return added;
  }

  function evict() {
    const idle = [...topics].filter(([topic, entry]) => entry.loaded && !keep(topic)).sort((a, b) => a[1].used - b[1].used);
    while (topics.size > MAX_TOPICS && idle.length) topics.delete(idle.shift()[0]);
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (!closed) timer = setTimeout(connect, ms);
    timer?.unref?.();
  }

  async function connect() {
    stream?.abort();
    const names = [...topics].filter(([, entry]) => entry.loaded).map(([topic]) => topic);
    if (closed || !names.length) return;
    const ctrl = new AbortController();
    stream = ctrl;
    let limited = false;
    try {
      for await (const ev of streamEvents(cfg, names, { since: String(latestTime - 1), signal: ctrl.signal, onOpen: () => { retry = RETRY_MIN_MS; } })) {
        add(ev.topic, [ev]);
        latestTime = Math.max(latestTime, ev.time);
      }
    } catch (error) {
      limited = error.ntfyStatus === 429;
    }
    if (stream !== ctrl || closed) return;
    schedule(limited ? Math.max(retry, RATE_LIMIT_MS) : retry);
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  }

  // tailBytes: history keeps the newest events when the topic's cache exceeds the poll cap.
  function open(topic, { tailBytes = 0 } = {}) {
    let entry = topics.get(topic);
    if (!entry) {
      entry = { events: [], ids: new Set(), loaded: false, used: 0 };
      topics.set(topic, entry);
      entry.ready = (async () => {
        let events;
        try {
          events = await pollCached(cfg, topic, "all", undefined, { tailBytes });
        } catch (error) {
          if (closed) return;
          if (!history.events(topic, 1).length) {
            topics.delete(topic);
            throw error;
          }
        }
        if (closed) return;
        if (events) history.add(topic, events);
        entry.loaded = true;
        add(topic, history.events(topic, HISTORY_LIMIT), { replay: true });
        evict();
        schedule(RESUBSCRIBE_MS);
      })();
    }
    entry.used = Date.now();
    return entry.ready;
  }

  return {
    open,
    record: event => add(event.topic, [event]),
    history,
    events: topic => topics.get(topic)?.events ?? [],
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      stream?.abort();
      history.close();
    },
  };
}
