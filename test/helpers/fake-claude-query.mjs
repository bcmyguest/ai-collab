// Scripted stand-in for the Agent SDK query(): records each call; the handshake hangs or fails when asked. Test-only; never the SDK or the CLI.
/** Returns {query, queries, events}; events lists "query" in call order, for ordering checks. */
export function fakeClaudeQuery({ hang = false, failInit = null } = {}) {
  const queries = [];
  const events = [];
  function query({ prompt, options }) {
    const record = { prompt, options, closed: false };
    queries.push(record);
    events.push("query");
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    record.q = {
      [Symbol.asyncIterator]: async function* messages() { await done; },
      initializationResult() {
        if (failInit) return Promise.reject(new Error(failInit));
        if (hang) return new Promise(() => {});
        return Promise.resolve({ models: [], commands: [] });
      },
      async interrupt() {},
      async setPermissionMode() {},
      async getContextUsage() { return { totalTokens: 0, maxTokens: 1 }; },
      close() { record.closed = true; finish(); },
    };
    return record.q;
  }
  return { query, queries, events };
}
