/**
 * In-process fake of the message bus: the production bus server (lib/bus.mjs) on the memory store, with the
 * test hooks wired in. Tests exercise the real protocol code; only the storage and the instrumentation differ.
 * No network beyond 127.0.0.1, no API keys, no agents.
 *
 * state keeps the counters tests drive and assert: publishes, polls, subscribes, requests, fileReads,
 * files (seedable Map), and the fault knobs failNext, limitNext, delayMs.
 */
import { createBusServer, openMemoryStore } from "../../lib/bus.mjs";

const LIMIT_BODY = JSON.stringify({ code: 42905, http: 429, error: "limit reached: daily bandwidth reached" });

export async function startFakeNtfy({ token = "" } = {}) {
  const store = openMemoryStore();
  const state = {
    publishes: [], polls: [], subscribes: [], fileReads: [], requests: 0,
    failNext: 0, limitNext: 0, delayMs: 0, files: store.files,
  };
  const hooks = {
    async onRequest() {
      state.requests += 1;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    },
    fault() {
      if (state.failNext <= 0) return undefined;
      state.failNext -= 1;
      return { status: 500, body: "injected failure" };
    },
    onPublish: (rec) => state.publishes.push(rec),
    onPoll(rec) {
      state.polls.push(rec);
      if (state.limitNext <= 0) return undefined;
      state.limitNext -= 1;
      return { status: 429, headers: { "content-type": "application/json" }, body: LIMIT_BODY };
    },
    onSubscribe: (rec) => state.subscribes.push(rec),
    onFileRead: (id) => state.fileReads.push(id),
  };
  const bus = createBusServer({ store, token, hooks });
  const url = await bus.listen();
  return {
    url,
    state,
    inject: (topic, message) => store.publish({ topic, message }),
    close: async () => { await bus.close(); store.close(); },
  };
}
