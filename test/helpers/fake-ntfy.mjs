/**
 * In-process fake of the message bus: the production bus server (lib/bus.mjs) on the memory store.
 * Tests exercise the real protocol code; only the storage differs. No network beyond 127.0.0.1,
 * no API keys, no agents.
 *
 * state keeps the counters tests drive and assert: publishes, polls, subscribes, requests, fileReads,
 * files (seedable Map), and the fault knobs failNext, limitNext, delayMs.
 */
import { createBusServer, openMemoryStore } from "../../lib/bus.mjs";

export async function startFakeNtfy({ token = "" } = {}) {
  const store = openMemoryStore();
  const bus = createBusServer({ store, token });
  const url = await bus.listen();
  return {
    url,
    state: bus.state,
    inject: (topic, message) => store.publish({ topic, message }),
    close: async () => { await bus.close(); store.close(); },
  };
}
